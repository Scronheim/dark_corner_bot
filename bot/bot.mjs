import fs from 'fs'
import { readdir } from 'fs/promises'
import { Telegraf, Markup } from 'telegraf'
import { message } from 'telegraf/filters'
import axios from 'axios'
import Seven from 'node-7z'
import { createExtractorFromFile } from 'node-unrar-js'
import _ from 'lodash'
import dayjs from 'dayjs'
import duration from 'dayjs/plugin/duration.js'

import PlexApi from './plex.mjs'
import { ALBUM_TYPES } from './consts.mjs'

dayjs.extend(duration)

const MUSIC_PATH = '/srv/music'
const API_URL = process.env.API_URL
const OUTER_API_URL = process.env.OUTER_API_URL
const WEB_URL = 'https://dark-corner.ru/web/index.html#!/server/2f5e25f41be9faf84718898e3b35e46a0df60d89'


class Bot {
  constructor(botToken, plexToken) {
    this.bot = new Telegraf(botToken, {
      telegram: {
        apiRoot: 'http://localhost:8081'
      }}
    )
    this.plexApi = new PlexApi(plexToken)
  }

  runBot = async () => {
    this.#registerCommands()

    process.once('SIGINT', () => this.bot.stop('SIGINT'))
    process.once('SIGTERM', () => this.bot.stop('SIGTERM'))

    console.log('Telegram bot started')
    await this.bot.launch()
  }

  #registerCommands = () => {
    this.bot.on('callback_query', this.#callbackQuery)

    this.bot.command('last', this.#getLastNAlbums)
    this.bot.command('post', this.#getAlbumById)
    this.bot.command('discography', this.#getDiscographyById)
    this.bot.command('s', this.#searchArtist)

    this.bot.on(message('text'), this.#parseInput)
  }

  #callbackQuery = async (ctx) => {
    const [command, firstArgument, secondArgument] = ctx.callbackQuery.data.split('|')
    switch (command) {
      case 'artistById':
        await this.#searchById(ctx, firstArgument)
        break
      case 'albumById':
        await this.#searchById(ctx, firstArgument)
        break
      case 'downloadArchive':
        await this.#downloadArchiveFromServer(ctx, firstArgument, true)
        break
      case 'downloadSong':
        await this.#downloadArchiveFromServer(ctx, firstArgument, false)
        break
    }
    await ctx.answerCbQuery()
  }

  #downloadArchiveFromServer = async (ctx, id, byArchive = true) => {
    const albumTracks = await this.plexApi.getIdChildren(id)
    if (byArchive) {
      const folderPath = `${albumTracks[0].Media[0].Part[0].file.replace('/data/', '/srv/music/').split('/').slice(0, -1).join('/')}`
      const archivePath = `${folderPath}/${albumTracks[0].grandparentTitle} - ${albumTracks[0].parentTitle}.7z`
      await ctx.reply('Подготавливается архив для скачивания')
      const archive = Seven.add(archivePath, folderPath, {recursive: true})
      archive.on('end', async () => {
        await ctx.replyWithDocument({source: archivePath, filename: `${albumTracks[0].grandparentTitle} - ${albumTracks[0].parentTitle}.7z`})
        fs.unlinkSync(archivePath)
      })
    } else {
      const mediaGroup = _.chunk(albumTracks.flatMap(track => {
        return track.Media.flatMap(media => {
          return media.Part.flatMap(part => {
            return {
              type: 'audio',
              media: {source: part.file.replace('/data/', '/srv/music/')},
              // caption: track.title
            }
          })
        })
      }), 10)
      for (const group of mediaGroup) {
        await ctx.replyWithMediaGroup(group)
      }
    }
  }

  #replyWithAlbum = async (ctx, album) => {
    const albumTracks = await this.plexApi.getIdChildren(album.ratingKey)
    const tracklist = albumTracks.flatMap(track => {
      return {index: track.index, title: track.title, duration: dayjs.duration(track.duration).format('mm:ss')}
    })
    const inline_keyboard = [[
      Markup.button.callback('Скачать архивом', `downloadArchive|${album.ratingKey}`),
      Markup.button.callback('Скачать по трекам', `downloadSong|${album.ratingKey}`),
    ]]
    await ctx.replyWithPhoto(
      {url: `${OUTER_API_URL}${album.thumb}?X-Plex-Token=${process.env.PLEX_TOKEN}`},
      {caption: 
`
Группа: ${album.parentTitle}
Альбом: ${album.title}
Год: ${album.year}
Жанр(ы): ${album.Genre.map(g => g.tag).join(' / ')}

Треклист:${tracklist.map(track => 
`
${track.index}. ${track.title} (${track.duration})`
).join('')}`, parse_mode: 'HTML', reply_markup: {inline_keyboard}})
  }

  #replyWithArtist = async (ctx, artist) => {
    const country = artist.Country[0].tag
    const inline_keyboard = artist.albums.map((album) => {
      return [
        Markup.button.callback(`${album.title} (${album.year})`, `albumById|${album.ratingKey}`, false),
      ]
    })
    await ctx.replyWithPhoto(
      {url: `${OUTER_API_URL}${artist.thumb}?X-Plex-Token=${process.env.PLEX_TOKEN}`},
      {caption: 
`
${artist.title} - ${artist.Genre.map(g => g.tag).join(' / ')} (${country})
`, parse_mode: 'HTML', reply_markup: {inline_keyboard}})
  }

  #searchById = async (ctx, id) => {
    const result = await this.plexApi.searchById(id)
    if (result.type === 'artist') {
      await this.#replyWithArtist(ctx, result)
    } else if (result.type === 'album') {
      await this.#replyWithAlbum(ctx, result)
    }
  }

  #searchArtist = async (ctx) => {
    const artists = await this.plexApi.search(ctx.payload)
    if (artists.Metadata?.length) {
      const inlineKeyboard = artists.Metadata.map((artist) => {
        const country = artist.Country ? artist.Country[0].tag : 'Неизвестно'
        return [
          Markup.button.callback(`${artist.title} (${country})`, `artistById|${artist.ratingKey}`),
        ]
      })
      await ctx.reply('Вот что нашлось',
        Markup.inlineKeyboard(inlineKeyboard)
      )
    } else {
      await ctx.reply('Ничего не найдено')
    }
  }

  #getDiscographyById = async (ctx) => {
    const artist = await this.plexApi.searchById(ctx.payload)
    const albums = await this.plexApi.getIdChildren(ctx.payload)
    await this.#prepareDiscography(ctx, artist, albums)
  }

  #getAlbumById = async (ctx) => {
    const response = await this.plexApi.searchById(ctx.payload)
    this.#prepareAlbums(ctx, response.data.MediaContainer.Metadata)
  }

  #getLastNAlbums = async (ctx) => {
    const limit = ctx.payload ? ctx.payload : 1
    const response = await this.plexApi.getLastAlbums(limit)
    this.#prepareAlbums(ctx, response)
  }

  #prepareDiscography = async (ctx, artist, albums) => {
    const discography = {
      artist: artist.title,
      artistGenre: artist.Genre.map(g => g.tag),
      country: artist.Country[0].tag,
      artistUrl: `${WEB_URL}/details?key=/library/metadata/${artist.ratingKey}`,
      artistThumbUrl: `${API_URL}${artist.thumb}?X-Plex-Token=${process.env.PLEX_TOKEN}`,
      albums: albums.map(a => {
        return {
          title: a.title,
          year: a.year,
          url: `${WEB_URL}/details?key=/library/metadata/${a.ratingKey}`,
          type: a.title.includes('EP') ? ALBUM_TYPES.EP
           : (a.title.includes('(Single)')) ? ALBUM_TYPES.Single
           : (a.title.includes('(Demo)')) ? ALBUM_TYPES.Demo
           : (a.title.includes('(Live)')) ? ALBUM_TYPES.Live
           : (a.title.includes('Instrument')) ? ALBUM_TYPES.Instrumental
           : (a.title.includes('Remix')) ? ALBUM_TYPES.Remixes
           : (a.title.includes('Reissue')) ? ALBUM_TYPES.Reissue
           : ALBUM_TYPES['Full-Lenght']
        }
      })
    }
    await this.#postDiscographyToChannel(ctx, discography)
  }

  #prepareAlbums = async (ctx, albums) => {
    for (const album of albums) {
      const artistInfo = await this.plexApi.searchByArtistTitle(album.parentTitle)
      const albumInfo = {
        artist: album.parentTitle,
        artistCountry: artistInfo.Country[0].tag,
        album: album.title,
        year: album.year,
        genres: album.Genre,
        parentKey: album.parentKey,
        artistUrl: `${WEB_URL}/details?key=/library/metadata/${album.parentRatingKey}`,
        albumUrl: `${WEB_URL}/details?key=/library/metadata/${album.ratingKey}`,
        coverUrl: `${API_URL}${album.thumb}?X-Plex-Token=${process.env.PLEX_TOKEN}`,
      }
      await this.#postAlbumToChannel(ctx, albumInfo)
    }
  }

  #parseInput = async (ctx) => {
    // грузим архив напрямую, формат artist__download url
    const splittedInput = ctx.update.message.text.split('__')
    const firstArgument = splittedInput[0]
    const secondArgument = splittedInput[1]
    this.#checkArtistExist(firstArgument)
    const filepath = await this.#downloadFile(firstArgument, secondArgument)
    this.#unpack(ctx, filepath, `${MUSIC_PATH}/${firstArgument}`)
  }

  #checkArtistExist = (artist) => {
     if (!fs.existsSync(`${MUSIC_PATH}/${artist}`)) fs.mkdirSync(`${MUSIC_PATH}/${artist}`)
  }

  #downloadFile = async (artist, downloadUrl) => {
    const filename = downloadUrl.split('/').pop()
    const filepath = `${MUSIC_PATH}/${artist}/${filename}`
    const writer = fs.createWriteStream(filepath)

    return axios({
      method: 'get',
      url: downloadUrl,
      responseType: 'stream',
    }).then(response => {
      return new Promise((resolve, reject) => {
        response.data.pipe(writer)
        let error = null
        writer.on('error', err => {
          error = err;
          writer.close()
          reject(err)
        });
        writer.on('close', () => {
          if (!error) resolve(filepath)
        })
      })
    })
  }

  #unpack = async (ctx, filepath, outputPath) => {
    const fileExtension = filepath.split('.').pop()
    switch (fileExtension) {
      case '7z':
      case 'tar':
        const myStream = Seven.extractFull(filepath, outputPath)
        myStream.on('end', async () => {
          await this.#unpackComplete(ctx, filepath, outputPath)
        })
        break
      case 'rar':
        try {
          const extractor = await createExtractorFromFile({
            filepath,
            targetPath: outputPath
          });
      
          [...extractor.extract().files]
          this.#unpackComplete(ctx, filepath, outputPath)
        } catch (err) {
          console.error(err)
        }
        break
      default:
        break
    }
  }

  #unpackComplete = async (ctx, filepath, outputPath) => {
    const dirs = await this.#listDirectories(outputPath)
    for (const dir of dirs) {
      fs.chmodSync(`${outputPath}/${dir}`, 0o755)
    }
    fs.unlinkSync(filepath)
    ctx.reply('Файл скачан и распакован')
    await this.plexApi.refreshLibrary()
  }

  #postDiscographyToChannel = async (ctx, discography) => {
    const fullLenghtAlbums = discography.albums.filter(a => a.type === ALBUM_TYPES['Full-Lenght'])
    const epAlbums = discography.albums.filter(a => a.type === ALBUM_TYPES.EP)
    const singlesAlbums = discography.albums.filter(a => a.type === ALBUM_TYPES.Single)
    const demoAlbums = discography.albums.filter(a => a.type === ALBUM_TYPES.Demo)
    const liveAlbums = discography.albums.filter(a => a.type === ALBUM_TYPES.Live)
    const remixesAlbums = discography.albums.filter(a => a.type === ALBUM_TYPES.Remixes)
    const instrumentalAlbums = discography.albums.filter(a => a.type === ALBUM_TYPES.Instrumental)
    const reissueAlbums = discography.albums.filter(a => a.type === ALBUM_TYPES.Reissue)

    let caption =
`
<a href="${discography.artistUrl}">${discography.artist}</a> - ${discography.artistGenre.join(' / ')} (${discography.country})
`
    if (fullLenghtAlbums.length) caption += 
`
Полноформатники: ${fullLenghtAlbums.map((a, index) => 
`
${index + 1}. <a href="${a.url}">${a.title}</a> (${a.year})`).join('')}
`
    if (epAlbums.length) caption +=
`
EP: ${epAlbums.map((a, index) =>
`
${index + 1}. <a href="${a.url}">${a.title}</a> (${a.year})`).join('')}
`
    if (singlesAlbums.length) caption +=
`
Синглы: ${singlesAlbums.map((a, index) =>
`
${index + 1}. <a href="${a.url}">${a.title}</a> (${a.year})`).join('')}
`

    if (demoAlbums.length) caption +=
`
Демо: ${demoAlbums.map((a, index) =>
`
${index + 1}. <a href="${a.url}">${a.title}</a> (${a.year})`).join('')}
`

    if (reissueAlbums.length) caption +=
`
Переиздания: ${reissueAlbums.map((a, index) =>
`
${index + 1}. <a href="${a.url}">${a.title}</a> (${a.year})`).join('')}
`

    if (liveAlbums.length) caption +=
`
Live: ${liveAlbums.map((a, index) =>
`
${index + 1}. <a href="${a.url}">${a.title}</a> (${a.year})`).join('')}
`

    if (remixesAlbums.length) caption +=
`
Ремиксы: ${remixesAlbums.map((a, index) =>
`
${index + 1}. <a href="${a.url}">${a.title}</a> (${a.year})`).join('')}
`

    if (instrumentalAlbums.length) caption +=
`
Инструментал: ${instrumentalAlbums.map((a, index) =>
`
${index + 1}. <a href="${a.url}">${a.title}</a> (${a.year})`).join('')}
`
    caption +=
`
#discography`
    ctx.telegram.sendPhoto('@dark_corner_ru', {url: discography.artistThumbUrl}, {caption, parse_mode: 'HTML'}) // 423754317   @dark_corner_ru
  }

  #postAlbumToChannel = async (ctx, albumInfo) => {
    ctx.telegram.sendPhoto('@dark_corner_ru', {url: albumInfo.coverUrl}, {caption: // 423754317   @dark_corner_ru
`
<a href="${albumInfo.artistUrl}">${albumInfo.artist}</a> - <a href="${albumInfo.albumUrl}">${albumInfo.album}</a> (${albumInfo.year})

Жанр(ы): ${albumInfo.genres.map(g => g.tag).join(' / ')}
Страна: ${albumInfo.artistCountry}
`,
    parse_mode: 'HTML'})
  }

  #sanitizeText = (text) => {
    return text.replaceAll(' ', '_').replaceAll('-', '_').replaceAll("'", '')
  }

  #sleep = async (seconds) => {
    return new Promise(resolve => {
      setTimeout(resolve, seconds * 1000);
    });
  }

  #listDirectories = async (pth) => {
    const directories = (await readdir(pth, {withFileTypes: true}))
      .filter(dirent => dirent.isDirectory())
      .map(dir => dir.name)
  
    return directories
  }
}

export default Bot

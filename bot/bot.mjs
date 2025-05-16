import fs from 'fs'
import { readdir, cp, unlink } from 'fs/promises'
import { Telegraf } from 'telegraf'
import { message } from 'telegraf/filters'
import axios from 'axios'
import Seven from 'node-7z'
import { createExtractorFromFile } from 'node-unrar-js'
import { parseFile } from 'music-metadata'
import mediaGroup from 'telegraf-media-group'
import { chunk } from 'lodash-es'

import { ALBUM_TYPES } from './consts.mjs'

const MUSIC_PATH = '/mnt/data/music'
const DOWNLOAD_DIR_PATH = '/mnt/data/deluge/downloads'

const API_URL = process.env.API_URL
const API_KEY = process.env.API_KEY
const WEB_URL = 'https://dark-corner.ru/web/index.html#!/server/b7b1b44bf93bed318ee81ff4ab60d9642f687193'
const CHANNEL_ID = '423754317' //423754317, @dark_corner_ru

const xhr = axios.create({
  baseURL: API_URL,
  method: 'GET',
  params: { 'X-Plex-Token': process.env.PLEX_TOKEN },
  headers: {
    Accept: 'application/json'
  }
})

class Bot {
  constructor(token) {
    this.bot = new Telegraf(token, {
      telegram: {
        apiRoot: 'http://127.0.0.1:8081'
      }
    })
  }

  runBot = async () => {
    this.#registerMiddlewares()
    this.#registerCommands()

    process.once('SIGINT', () => this.bot.stop('SIGINT'))
    process.once('SIGTERM', () => this.bot.stop('SIGTERM'))

    console.log('Telegram bot started')
    await this.bot.launch()
  }

  #registerMiddlewares = () => {
    this.bot.use(mediaGroup())
  }

  #registerCommands = () => {
    this.bot.command('last', this.#getLastNAlbums)
    this.bot.command('post', this.#getAlbumById)
    this.bot.command('discography', this.#getDiscographyById)
    this.bot.on('media_group', this.#parseMediaGroup)
    this.bot.on('document', this.#parseDocument)
    this.bot.on(message('text'), this.#parseText)
  }

  #parseDocument = async (ctx) => {
    const fileId = ctx.update.message.document.file_id
    const downloadLink = await this.bot.telegram.getFileLink(fileId)
    const artistName = this.#extractArtistName(ctx.update.message.document.file_name)
    await this.#unpack(ctx, downloadLink.pathname, `${MUSIC_PATH}/${artistName}`)
  }

  #parseMediaGroup = async (ctx) => {
    for (const message of ctx.mediaGroup) {
      const fileId = message.audio.file_id
      const fileName = message.audio.file_name
      const downloadLink = await this.bot.telegram.getFileLink(fileId)
      const filepath = downloadLink.pathname
      const tags = await parseFile(filepath, { skipCovers: true })
      const albumName = `${tags.common.year} - ${tags.common.album}`
      const artistName = message.audio.performer
      let distFilepath = `${DOWNLOAD_DIR_PATH}/${artistName}/${fileName}`

      if (albumName) {
        distFilepath = `${MUSIC_PATH}/${artistName}/${albumName}/${fileName}`
      }

      this.#checkArtistExist(artistName)
      await cp(filepath, distFilepath)
      await unlink(filepath)
    }
    await this.#downloadComplete(ctx)
  }

  #extractArtistName = (filename) => {
    // Удаляем расширение файла
    const baseName = filename.replace(/\.[^/.]+$/, '');

    // Проверяем распространенные разделители с пробелами и тире
    const commonSeparators = [/\s-\s/, /\s–\s/, /\s—\s/];
    for (const sep of commonSeparators) {
      const splitIndex = baseName.search(sep);
      if (splitIndex !== -1) {
        return baseName.substring(0, splitIndex).trim();
      }
    }

    // Проверяем другие разделители: "_", "(", "[", пробел и тире
    const otherSeparators = [/_/, /\(/, /\[/, /\s-\s?/, /-/];
    for (const sep of otherSeparators) {
      const splitIndex = baseName.search(sep);
      if (splitIndex !== -1) {
        return baseName.substring(0, splitIndex).trim();
      }
    }

    // Если разделителей нет, возвращаем исходное имя
    return baseName.trim();
  }

  #getDiscographyById = async (ctx) => {
    const artistResponse = (await xhr.get(`/library/metadata/${ctx.payload}`)).data
    const albumsResponse = (await xhr.get(`/library/metadata/${ctx.payload}/children`)).data
    const artist = artistResponse.MediaContainer.Metadata[0]
    const albums = albumsResponse.MediaContainer.Metadata
    await this.#prepareDiscography(ctx, artist, albums)
  }

  #getAlbumById = async (ctx) => {
    const response = await xhr.get(`/library/metadata/${ctx.payload}`)
    const tracksResponse = await xhr.get(`/library/metadata/${ctx.payload}/children`)
    const album = response.data.MediaContainer.Metadata[0]
    album.tracks = tracksResponse.data.MediaContainer.Metadata
    this.#prepareAlbums(ctx, [album])
  }

  #getLastNAlbums = async (ctx) => {
    const limit = ctx.payload ? ctx.payload : 1
    const response = await xhr.get(`/library/recentlyAdded?limit=${limit}`)
    const albumsPayload = []
    for (const album of response.data.MediaContainer.Metadata) {
      const tracksResponse = await xhr.get(`/library/metadata/${album.ratingKey}/children`)
      album.tracks = tracksResponse.data.MediaContainer.Metadata
      albumsPayload.push(album)
    }

    this.#prepareAlbums(ctx, albumsPayload)
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
          genre: a.Genre.map(g => g.tag),
          url: `${WEB_URL}/details?key=/library/metadata/${a.ratingKey}`,
          type: a.title.includes('EP') ? ALBUM_TYPES.EP
            : (a.title.includes('Single')) ? ALBUM_TYPES.Single
              : (a.title.includes('Demo')) ? ALBUM_TYPES.Demo
                : (a.title.includes('Live')) ? ALBUM_TYPES.Live
                  : (a.title.includes('Instrument')) ? ALBUM_TYPES.Instrumental
                    : (a.title.includes('Remix')) ? ALBUM_TYPES.Remixes
                      : ALBUM_TYPES['Full-Lenght']
        }
      })
    }
    await this.#postDiscographyToChannel(ctx, discography)
  }

  #prepareAlbums = async (ctx, albums) => {
    for (const album of albums) {
      const artistInfo = await xhr.get(`/library/sections/1/all?title=${album.parentTitle}`)
      const country = artistInfo.data.MediaContainer.Metadata[0].Country ? artistInfo.data.MediaContainer.Metadata[0].Country[0].tag : 'Неизвестно'
      const genres = album.Genre ? album.Genre.map(g => g.tag).join(' / ') : 'Не указан'
      const albumInfo = {
        artist: album.parentTitle,
        artistCountry: country,
        album: album.title,
        tracks: album.tracks,
        year: album.year,
        genres,
        parentKey: album.parentKey,
        artistUrl: `${WEB_URL}/details?key=/library/metadata/${album.parentRatingKey}`,
        albumUrl: `${WEB_URL}/details?key=/library/metadata/${album.ratingKey}`,
        coverUrl: `${API_URL}${album.thumb}?X-Plex-Token=${process.env.PLEX_TOKEN}`,
      }
      await this.#postAlbumToChannel(ctx, albumInfo)
    }
  }

  #parseText = async (ctx) => {
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
      case 'zip':
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
    await xhr.get(`${API_URL}/library/sections/1/refresh`)
    // await this.#sleep(10)
    // await this.#getLastNAlbums(ctx)
  }

  #downloadComplete = async (ctx) => {
    ctx.reply('Файлы скачаны')
    await xhr.get(`${API_URL}/library/sections/1/refresh`)
  }

  #postDiscographyToChannel = async (ctx, discography) => {
    const fullLenghtAlbums = discography.albums.filter(a => a.type === ALBUM_TYPES['Full-Lenght'])
    const epAlbums = discography.albums.filter(a => a.type === ALBUM_TYPES.EP)
    const singlesAlbums = discography.albums.filter(a => a.type === ALBUM_TYPES.Single)
    const demoAlbums = discography.albums.filter(a => a.type === ALBUM_TYPES.Demo)
    const liveAlbums = discography.albums.filter(a => a.type === ALBUM_TYPES.Live)
    const remixesAlbums = discography.albums.filter(a => a.type === ALBUM_TYPES.Remixes)
    const instrumentalAlbums = discography.albums.filter(a => a.type === ALBUM_TYPES.Instrumental)

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
    ctx.telegram.sendPhoto('@dark_corner_ru', { url: discography.artistThumbUrl }, { caption, parse_mode: 'HTML' }) // 423754317   @dark_corner_ru
  }

  #postAlbumToChannel = async (ctx, albumInfo) => {
    await ctx.telegram.sendPhoto(CHANNEL_ID, { url: albumInfo.coverUrl }, {
      caption:
        `
<a href="${albumInfo.artistUrl}">${albumInfo.artist}</a> - <a href="${albumInfo.albumUrl}">${albumInfo.album}</a> (${albumInfo.year})

Жанр(ы): ${albumInfo.genres}
Страна: ${albumInfo.artistCountry}
`,
      parse_mode: 'HTML'
    })
    const chunkedTracks = chunk(albumInfo.tracks, 10)
    for (const chunk of chunkedTracks) {
      const mediaGroup = chunk.map(track => {
        return {
          type: 'audio',
          media: { source: track.Media[0].Part[0].file.replace('/music', '/mnt/data/music') },
          performer: track.grandparentTitle,
          title: track.title,
          thumbnail: { url: albumInfo.coverUrl },
          duration: +(track.duration / 1000).toFixed(),
        }
      })
      await ctx.telegram.sendMediaGroup(CHANNEL_ID, mediaGroup, { disable_notification: true })
    }
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
    const directories = (await readdir(pth, { withFileTypes: true }))
      .filter(dirent => dirent.isDirectory())
      .map(dir => dir.name)

    return directories
  }
}

export default Bot

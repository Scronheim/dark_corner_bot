import fs from 'fs'
import { readdir } from 'fs/promises'
import { Telegraf } from 'telegraf'
import { message } from 'telegraf/filters'
import axios from 'axios'
import Seven from 'node-7z'
import { createExtractorFromFile } from 'node-unrar-js'

import { ALBUM_TYPES } from './consts.mjs'

const MUSIC_PATH = '/srv/music'
const API_URL = process.env.API_URL
const API_KEY = process.env.API_KEY
const WEB_URL = 'http://150.241.105.187:32400/web/index.html#!/server/2f5e25f41be9faf84718898e3b35e46a0df60d89'

const xhr = axios.create({
  baseURL: API_URL,
  method: 'GET',
  params: {'X-Plex-Token': process.env.PLEX_TOKEN},
  headers: {
    Accept: 'application/json'
  }
})

class Bot {
  constructor(token) {
    this.bot = new Telegraf(token)
  }

  runBot = async () => {
    this.#registerCommands()

    process.once('SIGINT', () => this.bot.stop('SIGINT'))
    process.once('SIGTERM', () => this.bot.stop('SIGTERM'))

    console.log('Telegram bot started')
    await this.bot.launch()
  }

  #registerCommands = () => {
    this.bot.command('last', this.#getLastNAlbums)
    this.bot.command('post', this.#getAlbumById)
    this.bot.command('discography', this.#getDiscographyById)
    this.bot.on(message('text'), this.#parseInput)
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
    this.#prepareAlbums(ctx, response.data.MediaContainer.Metadata)
  }

  #getLastNAlbums = async (ctx) => {
    const limit = ctx.payload ? ctx.payload : 1
    const response = await xhr.get(`/library/recentlyAdded?limit=${limit}`)
    this.#prepareAlbums(ctx, response.data.MediaContainer.Metadata)
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
          type: a.title.includes('EP') ? ALBUM_TYPES.EP : (a.title.includes('Single')) ? ALBUM_TYPES.Single : (a.title.includes('Demo')) ? ALBUM_TYPES.Demo : ALBUM_TYPES['Full-Lenght']
        }
      })
    }
    await this.#postDiscographyToChannel(ctx, discography)
  }

  #prepareAlbums = async (ctx, albums) => {
    for (const album of albums) {
      const artistInfo = await xhr.get(`/library/sections/1/all?title=${album.parentTitle}`)
      const albumInfo = {
        artist: album.parentTitle,
        artistCountry: artistInfo.data.MediaContainer.Metadata[0].Country[0].tag,
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
    await xhr.get(`${API_URL}/library/sections/1/refresh`)
    // await this.#sleep(10)
    // await this.#getLastNAlbums(ctx)
  }

  #postDiscographyToChannel = async (ctx, discography) => {
    const fullLenghtAlbums = discography.albums.filter(a => a.type === ALBUM_TYPES['Full-Lenght'])
    const epAlbums = discography.albums.filter(a => a.type === ALBUM_TYPES.EP)
    const singlesAlbums = discography.albums.filter(a => a.type === ALBUM_TYPES.Single)
    const demoAlbums = discography.albums.filter(a => a.type === ALBUM_TYPES.Demo)

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
    ctx.telegram.sendPhoto('423754317', {url: discography.artistThumbUrl}, {caption, parse_mode: 'HTML'}) // 423754317   @dark_corner_ru
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

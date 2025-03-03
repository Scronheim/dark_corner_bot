import fs from 'fs'
import { Telegraf } from 'telegraf'
import axios from 'axios'
import Seven from 'node-7z'
import { createExtractorFromFile } from 'node-unrar-js'

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
    // this.bot.on(message('text'), this.#parseInput)
  }

  #getAlbumById = async (ctx) => {
    const response = await xhr.get(`/library/metadata/${ctx.payload}`)
    this.#postAlbums(ctx, response.data.MediaContainer.Metadata)
  }

  #getLastNAlbums = async (ctx) => {
    const limit = ctx.payload ? ctx.payload : 1
    const response = await xhr.get(`/library/recentlyAdded?limit=${limit}`)
    this.#postAlbums(ctx, response.data.MediaContainer.Metadata)
  }

  #postAlbums = async (ctx, albums) => {
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
      await this.#postToChannel(ctx, albumInfo)
    }
  }

  #parseInput = async (ctx) => {
    const splittedInput = ctx.update.message.text.split('__')
    const firstArgument = splittedInput[0]
    const secondArgument = splittedInput[1]
     try {
      const parsingUrl = new URL(firstArgument)
      console.log(parsingUrl)
      // выкладываем пост
     } catch (_) {
      // грузим файл на сервак, формат artist__downloadUrl
      this.#checkArtistExist(firstArgument)
      const filepath = await this.#downloadFile(firstArgument, secondArgument)
      this.#unpack(ctx, filepath, `${MUSIC_PATH}/${firstArgument}`)
     }
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
          await this.#unpackComplete(ctx, filepath)
        })
        break
      case 'rar':
        try {
          // Create the extractor with the file information (returns a promise)
          const extractor = await createExtractorFromFile({
            filepath,
            targetPath: outputPath
          });
      
          // Extract the files
          [...extractor.extract().files]
          this.#unpackComplete(ctx, filepath)
        } catch (err) {
          // May throw UnrarError, see docs
          console.error(err)
        }
        break
      default:
        break
    }
  }

  #unpackComplete = async (ctx, filepath) => {
    fs.unlinkSync(filepath)
    ctx.reply('Файл скачан и распакован')
    await axios.post(`${API_URL}/Library/Refresh?api_key=${API_KEY}`)
    await this.#sleep(5)
    const response = await axios.get(`${API_URL}/Users/9524e6d89ca3462ab0c835fe742a41ba/Items/Latest?limit=1&api_key=${API_KEY}`)
    const latestItemId = response.data[0].Id
    const { data } = await axios.get(`${API_URL}/Users/9524e6d89ca3462ab0c835fe742a41ba/Items/${latestItemId}?api_key=${API_KEY}`)
    const albumInfo = {
      artist: data.AlbumArtist,
      album: data.Name,
      year: data.ProductionYear,
      genres: data.Genres,
      coverUrl: `${API_URL}/Items/${data.Id}/Images/Primary`,
      albumUrl: `${API_URL}/web/#/details?id=${latestItemId}`
    }
    await this.#postToChannel(ctx, albumInfo)
  }

  #postToChannel = async (ctx, albumInfo) => {
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
}

export default Bot

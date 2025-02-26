import fs from 'fs'
import { Telegraf, Markup, Input } from 'telegraf'
import { message } from 'telegraf/filters'
import axios from 'axios'
import Seven from 'node-7z'
import { createExtractorFromFile } from 'node-unrar-js'

const MUSIC_PATH = '/srv/music'
const API_URL = process.env.API_URL
const API_KEY = process.env.API_KEY
const WEB_URL = 'http://150.241.105.187:9180/#/library'

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
    this.bot.command('post', this.#postLastAlbum)
    // this.bot.on(message('text'), this.#parseInput)
  }

  #postLastAlbum = async (ctx) => {
    const limit = ctx.payload ? ctx.payload : 1
    const response = await axios.get(`${API_URL}/Users/9524e6d89ca3462ab0c835fe742a41ba/Items/Latest?limit=${limit}&api_key=${API_KEY}`)
    for (const album of response.data) {
      const latestItemId = album.Id
      const { data } = await axios.get(`${API_URL}/Users/9524e6d89ca3462ab0c835fe742a41ba/Items/${latestItemId}?api_key=${API_KEY}`)
      const albumInfo = {
        artist: data.AlbumArtist,
        artistId: data.ParentId,
        album: data.Name,
        year: data.ProductionYear,
        genres: data.Genres,
        coverUrl: `${API_URL}/Items/${data.Id}/Images/Primary`,
        albumUrl: `${WEB_URL}/albums/${latestItemId}`
      }
      await this.#postToChannel(ctx, albumInfo)
      await this.#sleep(1)
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
    ctx.telegram.sendPhoto('@dark_corner_ru', {url: albumInfo.coverUrl}, {caption: // 423754317
`
<a href="${WEB_URL}/album-artists/${albumInfo.artistId}">${albumInfo.artist}</a> - ${albumInfo.album} (${albumInfo.year})

${albumInfo.genres.join(' / ')}

<a href="${albumInfo.albumUrl}">Ссылка на альбом</a>
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

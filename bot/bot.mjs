import fs from 'fs'
import { Telegraf, Markup, Input } from 'telegraf'
import { message } from 'telegraf/filters'
import axios from 'axios'
import Seven from 'node-7z'

const MUSIC_PATH = '/srv/music'
const API_URL = process.env.API_URL
const API_KEY = process.env.API_KEY

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
    this.bot.on(message('text'), this.#parseInput)
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

  #unpack = (ctx, filepath, outputPath) => {
    const myStream = Seven.extractFull(filepath, outputPath)
    myStream.on('end', async () => {
      fs.unlinkSync(filepath)
      ctx.reply('Файл скачан и распакован')
      await axios.post(`${API_URL}/Library/Refresh?api_key=${API_KEY}`)
      await axios.post(`${API_URL}/Library/Refresh?api_key=${API_KEY}`)
    })
  }
}

export default Bot

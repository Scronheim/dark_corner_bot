import Bot from './bot/bot.mjs'

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN)

bot.runBot()

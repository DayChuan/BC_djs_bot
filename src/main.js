// Require the necessary discord.js classes
import { Client, Events, GatewayIntentBits, Message, Partials} from 'discord.js'
import dotenv from 'dotenv'
import vueInit from '@/core/vue'
import {loadCommands, loadEvents} from '@/core/loader'
import {useAppStroe} from '@/store/app'
//import { token } = require('./config.json');      // 官網範例檔案

vueInit();
dotenv.config();

loadCommands()

// Create a new client instance
const client = new Client({
     intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildMembers,
    ],
     partials: [
        Partials.Channel,
        Partials.Message,
        Partials.Reaction
     ],
});
const appStore = useAppStroe()
appStore.client = client

loadEvents()
// Log in to Discord with your client's token
client.login(process.env.TOKEN)
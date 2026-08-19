import { GatewayIntentBits } from 'discord.js'
import {defineStore} from 'pinia'

export const useAppStroe = defineStore('app',{
    state :() => ({
        client: null,
        commandsActionMap: null,
        //指令的 SlashCommandBuilder 清單。/help 靠它列出使用者能用的指令，
        //所以 loadCommands() 註冊完要順手放進來。
        commandList: null
    }),
    getters : {},
    actions :{},
})
import { GatewayIntentBits } from 'discord.js'
import {defineStore} from 'pinia'

export const useAppStroe = defineStore('app',{
    state :() => ({
        client: null,
        commandsActionMap: null
    }),
    getters : {},
    actions :{},
})
import {Events} from 'discord.js'
import {useAppStroe} from '@/store/app'

export const event = {
    name : Events.InteractionCreate
}

export const action = async(interaction) => {
    if(!interaction.isChatInputCommand()) return
    const appStroe = useAppStroe()
    const action = appStroe.commandActionMap.get(interaction.commandName)
    await action(interaction)
}
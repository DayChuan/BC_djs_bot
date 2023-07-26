import {Events, ActivityType} from "discord.js"

export const event = {
    name: Events.ClientReady,
    once: true,
    type: ActivityType.Playing
}

export const action =(c) => {
    c.user.setActivity('Node.js')
    console.log(`Ready! Logged in as ${c.user.tag}`)
}
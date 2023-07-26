import {defineStore} from 'pinia'

export const useAppStroe = defineStore('app',{
    state :() => ({
        clint: null,
        commandsActionMap: null
    }),
    getters : {},
    actions :{},
})
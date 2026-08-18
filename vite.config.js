import{defineConfig} from 'vite'
import path from 'path'

export default defineConfig({
    resolve:{
        alias:{
            '@':path.resolve(__dirname,'./src'),
        }
    },
    test:{
        //測試環境是 FreeBSD jail。vitest 預設用 worker_threads 開 worker，
        //在這裡會卡住 —— 症狀是先跑完的檔案正常，其餘檔案停在 0/N 不動，
        //加 --no-file-parallelism 就正常。改用子行程池避開，
        //這樣直接 yarn test 就行，不必每次記得加參數。
        pool:'forks',
    }
})

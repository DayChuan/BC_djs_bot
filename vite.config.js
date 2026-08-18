import{defineConfig} from 'vite'
import path from 'path'

export default defineConfig({
    resolve:{
        alias:{
            '@':path.resolve(__dirname,'./src'),
        }
    },
    test:{
        //測試環境是 FreeBSD jail，同時開多個 worker 會卡死：
        //先跑完的檔案正常，其餘停在 0/N 不動。換 pool(threads / forks)沒有差別，
        //只有把 worker 壓成一個(--no-file-parallelism)才跑得完，
        //所以問題在平行執行本身，不在 worker 的種類。
        //推測是 jail 內取到的 CPU 數是宿主機的，導致 vitest 開出遠超資源的 worker。
        //測試檔就三支、總共跑不到一秒，循序執行沒有任何損失。
        fileParallelism:false,
    }
})

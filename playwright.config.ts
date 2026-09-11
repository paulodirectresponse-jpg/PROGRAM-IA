import {defineConfig} from '@playwright/test';
export default defineConfig({
  testDir:'./browser-tests',
  use:{baseURL:'http://127.0.0.1:3000',screenshot:'only-on-failure'},
  webServer:{command:'npm run dev',url:'http://127.0.0.1:3000/api/health',reuseExistingServer:false,timeout:60000},
});

import {test,expect} from '@playwright/test';
test('login is mandatory and does not silently authenticate a default user',async({page,request})=>{
  await page.goto('/');
  await expect(page.getByRole('button',{name:'Entrar com Firebase Auth',exact:true})).toBeVisible();
  const response=await request.get('/api/projects');
  expect(response.status()).toBe(401);
  await expect(page.getByRole('button',{name:'Criar Conta',exact:true})).toBeVisible();
  await page.screenshot({path:'test-results/mandatory-login.png',fullPage:true});
});

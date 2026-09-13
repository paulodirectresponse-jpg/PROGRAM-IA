import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CloudSyncService } from './cloudSyncService.js';
import { SupabasePersistenceService } from './supabasePersistenceService.js';
import { SecretService } from './secretService.js';

export type MigrationReport={dryRun:boolean;userId:string;firebaseUid:string;tables:Record<string,number>;files:number;bytes:number;payloadHash:string;backupPath?:string;remote?:{records:number;files:number};reconciled?:boolean};

export class PersistenceMigrationService {
  static inspect(userId:string,firebaseUid:string):MigrationReport{
    const snapshot=CloudSyncService.export(userId),serialized=JSON.stringify(snapshot),tables=Object.fromEntries(Object.entries(snapshot.tables).map(([name,rows])=>[name,rows.length]));
    let files=0,bytes=0;for(const project of Object.values(snapshot.files))for(const value of Object.values(project)){files++;bytes+=Buffer.from(value,'base64').length;}
    const secrets=SecretService.validateEncryptedRows(snapshot.tables.user_secrets||[]);if(!secrets.valid)throw Error('Migração recusada: secrets locais não podem ser validados com a master key atual.');
    return{dryRun:true,userId,firebaseUid,tables,files,bytes,payloadHash:crypto.createHash('sha256').update(serialized).digest('hex')};
  }
  static async migrate(userId:string,firebaseUid:string,backupRoot=path.resolve('.data','migration-backups')):Promise<MigrationReport>{
    const report=this.inspect(userId,firebaseUid),snapshot=CloudSyncService.export(userId);fs.mkdirSync(backupRoot,{recursive:true});
    const backupPath=path.join(backupRoot,`${firebaseUid}-${report.payloadHash.slice(0,16)}.json`);if(!fs.existsSync(backupPath))fs.writeFileSync(backupPath,JSON.stringify(snapshot),'utf8');
    const pushed=await SupabasePersistenceService.pushCanonical(userId,firebaseUid,snapshot);if(pushed.status!=='synced')throw Error(`Migração não sincronizada: ${pushed.status}`);
    const pulled=await SupabasePersistenceService.pullCanonical(userId,firebaseUid);if(pulled.status!=='synced'||!pulled.snapshot)throw Error('Reconciliação falhou: leitura canônica indisponível.');
    const remoteFiles=Object.values(pulled.snapshot.files).reduce((n,items)=>n+Object.keys(items).length,0);if(remoteFiles!==report.files)throw Error(`Reconciliação de arquivos falhou: local=${report.files}, remoto=${remoteFiles}.`);
    return{...report,dryRun:false,backupPath,remote:{records:pushed.records||0,files:pushed.files||0},reconciled:true};
  }
}

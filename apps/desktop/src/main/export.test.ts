import { createDecipheriv, pbkdf2 as pbkdf2Callback } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { exportData, exportEncrypted, generateSyncFile, resetExportBaseDir, setExportBaseDir } from './export'
import { signChallengeToken } from './challenge-token'

const pbkdf2 = promisify(pbkdf2Callback)
const dirs: string[] = []
async function setup(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'focuslock-export-')); dirs.push(dir); setExportBaseDir(dir)
  await writeFile(join(dir, 'blocklist.txt'), 'example.com\nsecond.example\n', 'utf8')
  await writeFile(join(dir, 'blocked-apps.json'), JSON.stringify(['Chrome.exe']), 'utf8')
  await writeFile(join(dir, 'categories.json'), JSON.stringify({ social: { domains: ['example.com'] } }), 'utf8')
  await writeFile(join(dir, 'focus-rules.json'), JSON.stringify([{ id: 1, name: 'Night' }]), 'utf8')
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ silent_mode: true }), 'utf8')
  return dir
}
afterEach(async () => { resetExportBaseDir(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })
const token = () => signChallengeToken('export')

describe('exportData', () => {
  it('requires an export token before writing', async () => {
    const dir = await setup(); const path = join(dir, 'out.txt')
    await expect(exportData('txt', path, 'invalid')).rejects.toThrow('Invalid challenge token')
  })

  it('writes txt, csv, hosts and complete JSON metadata', async () => {
    const dir = await setup()
    await exportData('txt', join(dir, 'out.txt'), token())
    await exportData('csv', join(dir, 'out.csv'), token())
    await exportData('hosts', join(dir, 'out.hosts'), token())
    await exportData('json', join(dir, 'out.json'), token())
    expect(await readFile(join(dir, 'out.txt'), 'utf8')).toBe('example.com\nsecond.example\n')
    expect(await readFile(join(dir, 'out.csv'), 'utf8')).toContain('example.com,social')
    expect(await readFile(join(dir, 'out.hosts'), 'utf8')).toContain('0.0.0.0 example.com')
    const json = JSON.parse(await readFile(join(dir, 'out.json'), 'utf8'))
    expect(json).toMatchObject({ version: '1.0', patterns: ['example.com', 'second.example'], apps: ['Chrome.exe'], settings: { silent_mode: true } })
    expect(json.rules).toEqual([{ id: 1, name: 'Night' }])
  })
})

describe('encrypted and sync exports', () => {
  it('encrypts the portable payload with AES-256-GCM', async () => {
    const dir = await setup(); const path = join(dir, 'backup.focuslock')
    await exportEncrypted(path, 'correct horse battery staple', token())
    const backup = JSON.parse(await readFile(path, 'utf8'))
    expect(backup).toMatchObject({ version: '1.0', algorithm: 'aes-256-gcm', kdf: 'pbkdf2-sha512' })
    const key = await pbkdf2('correct horse battery staple', Buffer.from(backup.salt, 'base64'), backup.iterations, 32, 'sha512')
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(backup.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(backup.tag, 'base64'))
    const plain = Buffer.concat([decipher.update(Buffer.from(backup.ciphertext, 'base64')), decipher.final()])
    expect(JSON.parse(plain.toString('utf8')).patterns).toContain('example.com')
  })

  it('generates a transfer-ready sync buffer only with a challenge token', async () => {
    await setup()
    await expect(generateSyncFile('bad')).rejects.toThrow('Invalid challenge token')
    expect(JSON.parse((await generateSyncFile(token())).toString('utf8'))).toMatchObject({ sync_format: 'focuslock-sync', version: '1.0' })
  })
})

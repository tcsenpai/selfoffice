#!/usr/bin/env node
/** node tools/bump-shell-version.mjs 0.1.3: sets the shell app version (the installers' version) in package.json and the lockfile, nothing else reformatted. */
import { readFileSync, writeFileSync } from 'node:fs'

const version = process.argv[2]
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('usage: bump-shell-version.mjs <major.minor.patch>')
  process.exit(2)
}

function edit(file, pattern) {
  const text = readFileSync(file, 'utf8')
  const next = text.replace(pattern, (_, head) => `${head}"${version}"`)
  if (next === text && !text.match(pattern)?.[0].includes(`"${version}"`))
    throw new Error(`version not found in ${file}`)
  writeFileSync(file, next)
}

edit('apps/shell/package.json', /^(  "version": )"[^"]+"/m)
edit(
  'package-lock.json',
  /("apps\/shell": \{\n\s+"name": "@selfoffice\/shell",\n\s+"version": )"[^"]+"/,
)

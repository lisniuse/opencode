import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const indexPath = join(process.cwd(), 'dist', 'index.html')
let content = readFileSync(indexPath, 'utf-8')

// Remove crossorigin attributes
content = content.replace(/ crossorigin/g, '')

writeFileSync(indexPath, content)
console.log('Removed crossorigin attributes from index.html')

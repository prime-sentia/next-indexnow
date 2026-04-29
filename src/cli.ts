#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { generateKey } from './index';

// Determine the root directory of the project where the script is being run.
// This is usually `process.cwd()`.
const projectRoot = process.cwd();

async function init() {
  console.log('\n🚀 Starting IndexNow automatic setup by Prime Sentia AI...\n');

  // 1. Generate Key
  const key = generateKey();
  console.log(`🔑 Generated secure IndexNow Key: ${key}`);

  // 2. Write to public/[key].txt
  const publicDir = path.join(projectRoot, 'public');
  if (fs.existsSync(publicDir)) {
    const filePath = path.join(publicDir, `${key}.txt`);
    try {
      fs.writeFileSync(filePath, key, 'utf8');
      console.log(`✅ Created verification file at: public/${key}.txt`);
    } catch (err) {
      console.error(`❌ Failed to write file to public directory: ${err}`);
    }
  } else {
    console.log(`⚠️  Could not find 'public/' directory. You are likely not at the root of a Next.js project.`);
    console.log(`   Please create a file named '${key}.txt' in your public folder with the content: ${key}`);
  }

  // 3. Update .env.local
  const envLocalPath = path.join(projectRoot, '.env.local');
  const envPath = path.join(projectRoot, '.env');
  
  let targetEnvPath = envLocalPath;
  let targetEnvName = '.env.local';

  // If .env.local doesn't exist but .env does, we append to .env
  if (!fs.existsSync(envLocalPath) && fs.existsSync(envPath)) {
    targetEnvPath = envPath;
    targetEnvName = '.env';
  }

  const envLine = `\n# Added by next-indexnow\nINDEXNOW_KEY=${key}\n`;

  try {
    if (fs.existsSync(targetEnvPath)) {
      const content = fs.readFileSync(targetEnvPath, 'utf8');
      if (content.includes('INDEXNOW_KEY=')) {
        console.log(`⚠️  INDEXNOW_KEY already exists in ${targetEnvName}. Skipping env update.`);
      } else {
        fs.appendFileSync(targetEnvPath, envLine);
        console.log(`✅ Added INDEXNOW_KEY to ${targetEnvName}`);
      }
    } else {
      fs.writeFileSync(targetEnvPath, envLine, 'utf8');
      console.log(`✅ Created ${targetEnvName} and added INDEXNOW_KEY`);
    }
  } catch (err) {
    console.error(`❌ Failed to update ${targetEnvName}: ${err}`);
  }

  console.log('\n🎉 Setup complete! You are ready to notify search engines instantly.');
}

const args = process.argv.slice(2);

if (args[0] === 'init') {
  init().catch(console.error);
} else {
  console.log('Usage: npx next-indexnow init');
}

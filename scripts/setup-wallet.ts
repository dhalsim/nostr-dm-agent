import readline from 'readline';

import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

import { getEnvFromFile, setEnvInFile } from '../src/env-file';

const ENV_PATH = '.env';

function question(prompt: string, defaultValue?: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    const defaultPrompt = defaultValue
      ? ` (leave empty for ${defaultValue})`
      : '';

    rl.question(`${prompt}${defaultPrompt}: \n > `, (answer) => {
      rl.close();
      resolve(answer.trim() ?? defaultValue ?? '');
    });
  });
}

async function main() {
  if (getEnvFromFile(ENV_PATH, 'CASHU_MNEMONIC')) {
    console.error(
      'CASHU_MNEMONIC already exists in .env. Remove it first if you want to regenerate.',
    );

    process.exit(1);
  }

  const defaultMintUrl = await question(
    'Enter your default Cashu mint URL',
    'https://mint.minibits.cash/Bitcoin',
  );

  if (defaultMintUrl) {
    setEnvInFile(ENV_PATH, 'CASHU_DEFAULT_MINT_URL', defaultMintUrl);
  }

  const mnemonic = bip39.generateMnemonic(wordlist, 128); // 12 words

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║           CASHU WALLET SETUP — READ CAREFULLY            ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log('║ Your mnemonic (12 words) is your ONLY wallet recovery    ║');
  console.log('║ key. Write it on paper and store it somewhere safe.      ║');
  console.log('║ It will be saved to .env and NOT shown again.            ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');
  console.log(`  ${mnemonic}\n`);

  // two step confirmation
  // confirm backup phrase

  await question('Press enter to confirm you backed up your mnemonic');

  console.clear();

  // random number 0-11

  const chosenWordIndices: number[] = [];

  for (let i = 0; i < 3; i++) {
    const randomNumber = Math.floor(Math.random() * 12);

    while (true) {
      if (chosenWordIndices.includes(randomNumber)) {
        continue;
      }

      chosenWordIndices.push(randomNumber);
      break;
    }

    console.clear();

    const word = await question(
      `Enter the word at position ${randomNumber + 1} (1-12)`,
    );

    if (word !== mnemonic.split(' ')[randomNumber]) {
      console.error('Incorrect word. Try again.');
      process.exit(1);
    }
  }

  setEnvInFile(ENV_PATH, 'CASHU_MNEMONIC', mnemonic);

  console.log('✓ Written to .env');

  console.log(
    '✓ Wallet setup complete. Mnemonic is only in .env and your backup',
  );

  console.log('  Start the bot normally: bun run start');

  process.exit(0);
}

main().catch(console.error);

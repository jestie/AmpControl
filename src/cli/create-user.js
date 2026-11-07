#!/usr/bin/env node
require('dotenv').config();
const { createUser } = require('../auth/users');

function askLine(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    let value = '';
    const stdin = process.stdin;
    const onData = (chunk) => {
      const text = chunk.toString('utf8');
      for (const char of text) {
        if (char === '\n' || char === '\r' || char === '\u0004') {
          cleanup();
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          cleanup();
          process.stdout.write('\nCancelled\n');
          process.exit(1);
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (char >= ' ') value += char;
      }
    };
    const cleanup = () => {
      process.stdin.removeListener('data', onData);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

async function main() {
  const username = (process.argv[2] || await askLine('Username: ')).trim();
  const password = await askLine('Password (not echoed, 10+ characters): ');
  const confirm = await askLine('Repeat password: ');

  if (password !== confirm) {
    console.error('Passwords do not match. Nothing was created.');
    process.exit(1);
  }

  try {
    const user = await createUser(username, password);
    console.log(`User "${user.username}" created.`);
  } catch (e) {
    console.error(`Could not create user: ${e.message}`);
    process.exit(1);
  }
}

main();

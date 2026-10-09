// Prints a new SECRETS_KEY for Backend/.env. It writes nothing: copy the line yourself.
import { randomBytes } from 'node:crypto';

console.log(`SECRETS_KEY=${randomBytes(32).toString('base64')}`);
console.log('\nPut this line in Backend/.env (never in git). Keep a private copy: without the same key,');
console.log('saved secrets such as the email password cannot be read and must be entered again.');

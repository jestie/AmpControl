const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DEFAULT_USERS_FILE = path.join(__dirname, '../../data/users.json');
const BCRYPT_ROUNDS = 12;
// A real hash of a throwaway password: comparing against it keeps the timing of
// "no such user" close to "wrong password" so usernames cannot be enumerated.
const DUMMY_HASH = '$2a$12$BEDIWd82hAMvQz46rT6Mges///HkUpZQkvtmQIr1KqtZaqy5z5uny';

function usersFile() {
  return process.env.USERS_FILE || DEFAULT_USERS_FILE;
}

function loadUsers() {
  try {
    const data = fs.readFileSync(usersFile(), 'utf8');
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function saveUsers(users) {
  const file = usersFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function validateCredentials(username, password) {
  if (typeof username !== 'string' || !/^[A-Za-z0-9._-]{3,32}$/.test(username)) {
    throw new Error('username must be 3-32 characters: letters, numbers, dot, dash or underscore');
  }
  if (typeof password !== 'string' || password.length < 10) {
    throw new Error('password must be at least 10 characters');
  }
}

async function createUser(username, password) {
  validateCredentials(username, password);
  const users = loadUsers();
  if (users.some((user) => user.username.toLowerCase() === username.toLowerCase())) {
    throw new Error('user already exists');
  }
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const user = {
    id: Date.now().toString(),
    username,
    passwordHash,
    createdAt: new Date().toISOString()
  };
  users.push(user);
  saveUsers(users);
  return { id: user.id, username: user.username, createdAt: user.createdAt };
}

async function verifyUser(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string') return null;
  const users = loadUsers();
  const user = users.find((entry) => entry.username.toLowerCase() === username.toLowerCase());
  const hash = user ? user.passwordHash : DUMMY_HASH;
  const ok = await bcrypt.compare(password, hash);
  if (!user || !ok) return null;
  return { id: user.id, username: user.username };
}

module.exports = { loadUsers, createUser, verifyUser, validateCredentials };

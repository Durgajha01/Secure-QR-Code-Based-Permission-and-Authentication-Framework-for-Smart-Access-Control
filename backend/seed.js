// seed.js — populates demo accounts. Run with: npm run seed
// Passwords are salted-scrypt hashed. Demo logins use email + password.

const crypto = require("crypto");
const { db } = require("./db");

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}

const users = [
  // id        name            role      pin    linked_student_id  phone
  ["STU001", "Aditi Rao",      "student", "1111", null,     "9900001111"],
  ["STU002", "Kabir Shah",     "student", "2222", null,     "9900002222"],
  ["STU003", "Meera Iyer",     "student", "3333", null,     "9900003333"],
  ["WRD01",  "Warden Suresh",  "warden",  "5555", null,     "9900005555"],
  ["PAR001", "Mrs. Rao",       "parent",  "6666", "STU001", "9900006666"],
  ["PAR002", "Mr. Shah",       "parent",  "7777", "STU002", "9900007777"],
  ["PAR003", "Mrs. Iyer",      "parent",  "8888", "STU003", "9900008888"],
  ["ADM01",  "Admin Office",   "admin",   "9999", null,     "9900009999"],
];

const insert = db.prepare(`
  INSERT OR REPLACE INTO users (id, name, role, pin_hash, password_hash, email, linked_student_id, phone)
  VALUES (?, ?, ?, '', ?, ?, ?, ?)
`);

const tx = db.transaction((rows) => {
  for (const [id, name, role, pin, linked, phone] of rows) {
    insert.run(id, name, role, hashPassword(pin + pin), `${id.toLowerCase()}@hostel.test`, linked, phone);
  }
});

tx(users);

console.log("Seeded demo users:");
console.table(users.map(([id, name, role, pin]) => ({ role, name, email: `${id.toLowerCase()}@hostel.test`, password: pin + pin })));
console.log("\nLogin with the email + password shown above.");

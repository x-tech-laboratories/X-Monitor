// `npm run hash-password [name]`: asks for a password and writes the `name:hash` line to the accounts file named by
// X_MONITOR_PASSWORD_HASH_FILE, or prints it when the variable is unset.

import { hash_password_command } from "@x-tech-laboratories/x-libs/server/hash_password";

await hash_password_command("X_MONITOR_PASSWORD_HASH_FILE");

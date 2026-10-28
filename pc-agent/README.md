# Asuka PC agent

Lets Brandon run a few **named** commands on his PC by text. Flow:

1. Brandon texts Asuka, e.g. "pc lock". Asuka asks for the PIN.
2. Brandon texts the PIN. Asuka queues `lock` through `/api/sync` `pc_enqueue`; the dashboard
   keeps only `scrypt(PIN, random salt)`, never the PIN, and the command expires after 10 minutes.
3. This agent (running on the PC) polls `/api/pc`, hashes its **local** PIN with the same salt,
   and runs the command only if it matches **and** the name is in its local allowlist.
4. The result goes back to the dashboard; Asuka texts it to Brandon.

## Install (Windows)

1. Install Python 3 (python.org). Copy this folder to the PC, e.g. `C:\asuka`.
2. Allowed commands: copy `pc-commands.example.json` to `%USERPROFILE%\.asuka\pc-commands.json`
   and edit it. Each entry is a name and the exact program + arguments to run (no shell).
3. Set the secrets **on the PC only** (new terminals pick them up):
   ```
   setx ASUKA_PC_PIN "<your PIN, 4-12 digits>"
   setx ASUKA_PC_TOKEN "<same value as ASUKA_PC_TOKEN on Vercel>"
   ```
4. Test: `python C:\asuka\asuka_pc_agent.py --once`
5. Run at logon: Task Scheduler → Create Task → trigger "At log on" → action
   `pythonw.exe C:\asuka\asuka_pc_agent.py`.

Changing the PIN = `setx ASUKA_PC_PIN` again and restart the agent. Removing a command from
the JSON file disables it immediately.

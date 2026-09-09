# WCKD

A Telegram-operated execution bot.

## What it does

Watches for an on-chain condition and executes immediately when it is met.
Everything is driven from Telegram — there is no terminal step on the day.

Each participant gets their own generated wallet, funds it themselves, and holds
their own key. There is no shared wallet and no pooled balance.

## Running it

```bash
npm install
cp .env.example .env      # fill it in
npm run status            # pre-flight, works before any wallet exists
npm run watch             # the watcher plus the Telegram front door
```

## Commands

```
/start      generate your wallet, get the address to fund
/balance    what it holds
/spend N    how much of it to use
/status     current state and countdown
/position   what you are holding
/export     your private key, DM only
/who        everyone taking part

owner only
/prep       prepare every funded wallet ahead of time
/arm        go live
/disarm     stand down
```

## Safety

- **Nothing executes until `/arm`.** Without it the whole path runs and prints
  the transaction instead of sending it.
- **A hard per-wallet cap** is enforced above whatever the config says.
- **A floor on the trigger condition**, so dust cannot bait an execution. It does
  not latch on a rejection — the real signal may be seconds behind.
- **Arm state survives a restart for six hours**, so a crash near the window
  cannot silently stand it down, and it cannot come back live days later.
- **Keys are encrypted at rest** and the export refuses to print in a group.

## Deploying

```bash
./deploy.sh <ip> <key.pem>
```

Ubuntu, systemd, restarts on failure and on reboot.

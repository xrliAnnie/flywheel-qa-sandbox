# Setup Discord Lead

Set up a new Lead with independent Discord bot and per-lead channel isolation.

**Usage**: `/setup-discord-lead <lead-name> <role>`

Example: `/setup-discord-lead finance-lead "Finance Lead"`

---

## Naming Convention: Disney Characters

Each Lead is named after a Disney character whose first letter matches the department:

| Department Letter | Character | Disney Source | Current Lead |
|-------------------|-----------|---------------|-------------|
| **P** (Product) | **Peter** | Peter Pan (1953) | product-lead ✅ |
| **O** (Operations) | **Oliver** | Oliver & Company (1988) | ops-lead ✅ |
| **F** (Finance) | Flynn | Tangled (2010) | — |
| **M** (Marketing) | Moana | Moana (2016) | — |
| **D** (Design) | Dumbo | Dumbo (1941) | — |
| **E** (Engineering) | Elsa | Frozen (2013) | — |
| **S** (Sales) | Simba | The Lion King (1994) | — |
| **H** (HR) | Hercules | Hercules (1997) | — |

**Rules**:
- Pick well-known Disney characters for easy recognition
- Bot name format: `{CharacterName} - {Department} Lead` (e.g., "Peter - Product Lead")
- Avatar: download official Disney clip art from disneyclips.com or similar, resize to 1024x1024 PNG
- Set avatar via Discord API: `PATCH /users/@me` with `{"avatar": "data:image/png;base64,{b64}"}`

---

## Input

Parse arguments:
- `lead-name`: kebab-case identifier (e.g., `finance-lead`)
- `role`: human-readable role name (e.g., "Finance Lead")

If no arguments, ask the user for:
1. Lead name (kebab-case, e.g., `finance-lead`)
2. Human name — pick from Disney character table above (first letter matches department)
3. Role description (e.g., "Finance department — budgets, invoices, payroll")
4. Which Discord channels this lead should use (or create new ones)

---

## Step 1: Create Discord Application (Browser)

Guide the user or use Chrome automation:

1. Navigate to https://discord.com/developers/applications
2. **Account**: Use school account (xiaorongli2011@u.northwestern.edu)
3. Create Application named `{HumanName} - {Role}` (e.g., "Frank - Finance Lead")
4. Bot tab → Reset Token → save token
5. **Privileged Gateway Intents**: Enable `Server Members Intent` + `Message Content Intent`
6. **Save Changes** — verify save succeeded (MFA may interrupt)
7. Record Application ID

---

## Step 1.5: Set Bot Avatar

After obtaining the bot token, set the Disney character avatar:

```bash
# 1. Download character image from disneyclips.com
curl -sL -o /tmp/{lead-name}-raw.png "https://www.disneyclips.com/images/images/{character-name}.png" -H "User-Agent: Mozilla/5.0"

# 2. Resize to 1024x1024 square with transparent padding
python3 -c "
from PIL import Image
img = Image.open('/tmp/{lead-name}-raw.png').convert('RGBA')
size = max(img.size)
square = Image.new('RGBA', (size, size), (255, 255, 255, 0))
square.paste(img, ((size - img.width) // 2, (size - img.height) // 2))
square.resize((1024, 1024), Image.LANCZOS).save('/tmp/{lead-name}-avatar.png', 'PNG')
"

# 3. Upload via Discord API
B64=$(base64 -i /tmp/{lead-name}-avatar.png)
curl -s -X PATCH "https://discord.com/api/v10/users/@me" \
  -H "Authorization: Bot {BOT_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "User-Agent: DiscordBot (flywheel, 1.0)" \
  -d "{\"avatar\": \"data:image/png;base64,$B64\"}"
```

Verify: check the bot's profile in Discord shows the new avatar.

---

## Step 2: Invite Bot to Server

**CRITICAL: Do NOT use Administrator permission.**

Calculate permissions:
```python
# VIEW_CHANNEL + SEND_MESSAGES + SEND_IN_THREADS + READ_HISTORY + ADD_REACTIONS + USE_SLASH
permissions = 277025459264
```

Generate and open invite URL:
```
https://discord.com/oauth2/authorize?client_id={APP_ID}&scope=bot&permissions=277025459264&guild_id=1485787271192907816&disable_guild_select=true
```

Verify the authorize page does NOT show "Administrator" in the permissions list.

---

## Step 3: Create DISCORD_STATE_DIR

```bash
LEAD_NAME="{lead-name}"  # e.g., "finance-lead"
STATE_DIR="$HOME/.claude/channels/discord-${LEAD_NAME}"

# Create directory structure
mkdir -p "$STATE_DIR/approved"

# Save bot token
echo "DISCORD_BOT_TOKEN={token}" > "$STATE_DIR/.env"
chmod 600 "$STATE_DIR/.env"

# Create access.json with ONLY this lead's channels
cat > "$STATE_DIR/access.json" << 'EOF'
{
  "dmPolicy": "pairing",
  "allowFrom": ["1138241636057481306"],
  "groups": {
    "{chat-channel-id}": { "requireMention": false, "allowFrom": [] },
    "{forum-channel-id}": { "requireMention": false, "allowFrom": [] },
    "{control-channel-id}": { "requireMention": false, "allowFrom": [] }
  },
  "pending": {}
}
EOF
chmod 600 "$STATE_DIR/access.json"
```

### Critical Checklist

- [ ] `approved/` directory created
- [ ] `dmPolicy` is `"pairing"` (NOT `"disabled"`)
- [ ] `allowFrom` has user's Discord ID `"1138241636057481306"`
- [ ] `groups` has ONLY this lead's channel IDs
- [ ] `.env` and `access.json` permissions are `600`

---

## Step 4: Save Token

```bash
echo "{LEAD_NAME_UPPER}_BOT_TOKEN={token}" >> ~/.flywheel/.env
```

---

## Step 5: Clear Default State Dir

Ensure default `~/.claude/channels/discord/access.json` has empty groups:

```json
{
  "dmPolicy": "disabled",
  "allowFrom": [],
  "groups": {},
  "pending": {}
}
```

And default `.env` has no bot token.

This prevents other Claude Code sessions from connecting as stale bots.

---

## Step 6: Create Control Channel (Optional)

If Bridge needs to send events to this Lead:

```bash
source ~/.claude/channels/discord/.env.bak  # ClaudeBot token

curl -X POST "https://discord.com/api/v10/guilds/1485787271192907816/channels" \
  -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "{lead-name}-control",
    "type": 0,
    "parent_id": "1486031301764190270",
    "permission_overwrites": [
      {"id": "1485787271192907816", "type": 0, "deny": "1024"},
      {"id": "{claudebot-id}", "type": 1, "allow": "274877975552"},
      {"id": "{new-bot-id}", "type": 1, "allow": "66560"}
    ]
  }'
```

Add the control channel ID to the lead's `access.json` groups.

---

## Step 7: Create Agent File

Create `{project-dir}/.lead/{lead-name}/agent.md` based on existing agent template:

- Change `name`, `description`
- Add `memory: user`
- Set persona (role, responsibilities, focus areas)
- Set channel IDs in the Channel IDs table
- Add channel isolation rules with the lead's specific channel IDs

---

## Step 8: Update projects.json

Add or update the lead entry in `~/.flywheel/projects.json`:

```json
{
  "agentId": "{lead-name}",
  "forumChannel": "{forum-id}",
  "chatChannel": "{chat-id}",
  "match": { "labels": ["{Label}"] },
  "runtime": "claude-discord",
  "controlChannel": "{control-id}"
}
```

---

## Step 9: Launch and Test

```bash
export DISCORD_STATE_DIR=$HOME/.claude/channels/discord-{lead-name}
source ~/.flywheel/.env
export DISCORD_BOT_TOKEN=${LEAD_VAR}

cd ~/Dev/flywheel/packages/teamlead
LEAD_WORKSPACE=/path/to/project/org/.lead/{lead-name} \
  ./scripts/claude-lead.sh {lead-name} /path/to/project {project-name}
```

### Verification

1. Check `tmux capture-pane` — `ctx` should increase when user sends message
2. Send message in the lead's chat channel → only this lead responds
3. Send message in another lead's channel → this lead does NOT respond or show typing
4. No "Product Lead" or other stale bots typing

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| ctx stays 0% | `dmPolicy: "disabled"` or missing `approved/` dir | Fix access.json, create `approved/` |
| All bots respond | Administrator permission on bot | Kick bot, re-invite without Admin |
| "Product Lead" typing | Default `.env` has token, or other session connected | Clear default `.env` and `access.json` groups |
| Bot typing but no reply | Channel not in this lead's `access.json` groups | Add channel ID to groups |
| MFA fails during save | Discord session issue | Try "Verify with something else" |

---

## Reference: Current Setup

| Lead | Bot | State Dir | App ID |
|------|-----|-----------|--------|
| product-lead | Peter - Product Lead | discord-peter | 1485896147951419434 |
| ops-lead | Oliver - Ops Lead | discord-oliver | 1485899317850935316 |

Guild: `1485787271192907816` (claude's server)
ClaudeBot (Bridge): `1484685699004497940`
User Discord ID: `1138241636057481306`
Control Category: `1486031301764190270`

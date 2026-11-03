# Ronch Excel – WhatsApp Catalogue Bot

Visitor scans the stand QR → WhatsApp opens with "Hi, please send me your catalogue" → they tap send →
the bot replies with a menu (Facade, Landscape, Solar, LED Drivers CV & CC, Indoor, All, Talk to sales) →
they pick one → the PDF arrives. Every visitor is saved to a lead list on your site:
open `https://<your-site>/leads`, enter your password, see the table or download it as CSV for Excel.
No email is used anywhere.

Visitors message first, so every reply is inside WhatsApp's 24-hour customer-service window: no
message templates to get approved, and under Meta's current pricing these replies are not charged
(confirm on Meta's pricing page when you set up billing).

## What's in this folder (a complete, standalone Netlify site)

| File | What it is |
|---|---|
| `netlify.toml` | Tells Netlify where the site and functions are |
| `public/index.html` | Simple home page for the site |
| `netlify/functions/whatsapp.js` | The bot (webhook) |
| `netlify/functions/catalogues.json` | Division names, menu descriptions, PDF file names, welcome text — edit freely |
| `public/whatsapp-qr.html` | Printable A4 QR poster for the stand |
| `public/privacy.html` | Privacy policy page (Meta needs one to make the app Live) |
| `public/catalogues/*.pdf` | Your five catalogue PDFs (you add these) |

No packages to install and no build step.

## 0. Create the repo and the Netlify site

1. On GitHub: **New repository** → name it `ronch-whatsapp-bot` (Private is fine) → Create.
2. Upload everything inside this folder (keep the folder structure: `netlify.toml` at the top level,
   `public/` and `netlify/` beside it) → Commit.
3. On Netlify: **Add new site → Import an existing project → GitHub** → pick `ronch-whatsapp-bot`.
   Leave Build command empty, Publish directory `public` (it's read from `netlify.toml`) → Deploy.
4. Optional: Site configuration → Change site name, e.g. `ronch-catalogue` →
   your address becomes `https://ronch-catalogue.netlify.app`.

## 1. Catalogue PDFs

Put them in `public/catalogues/` with exactly these names (or change the names in `catalogues.json`):

- `facade.pdf`
- `landscape.pdf`
- `solar.pdf`
- `led-drivers.pdf`
- `indoor.pdf`

Keep each under about 5 MB so they arrive fast on hall mobile data. Check the short descriptions in
`catalogues.json` (max 72 characters each) match your actual range.

## 2. Phone number

Use a dedicated number (new SIM is easiest) that is **not** registered on the WhatsApp or WhatsApp
Business app. If it is, delete the WhatsApp account on that phone first (Settings → Account → Delete
account). It only needs to receive one OTP by SMS or call.

## 3. Meta setup (do this first — verification can take several days)

1. **Business portfolio:** go to business.facebook.com, create or open the Ronch Excel Industries
   portfolio, then Settings → Business info → **Start verification** (GST certificate / utility bill
   with the Daman or Mumbai address, and a company email or phone that can receive a code).
2. **App:** developers.facebook.com → My Apps → Create app → use case "Other" → type **Business** →
   link it to the portfolio. Add the **WhatsApp** product.
3. **Number:** WhatsApp → API Setup → Add phone number. Display name: "Ronch Excel Industries"
   (it must match your business name; Meta reviews it). Verify with the OTP.
   Copy the **Phone number ID** → this is `WA_PHONE_NUMBER_ID`.
4. **Billing:** in WhatsApp Manager, add a payment method (needed on a live number even if usage stays free).
5. **Permanent token:** business.facebook.com → Settings → Users → **System users** → Add (Admin) →
   Assign assets: your app (full control) and your WhatsApp account (full control) →
   Generate token → choose the app → expiry **Never** → permissions `whatsapp_business_messaging`
   and `whatsapp_business_management`. Copy it → this is `WA_TOKEN`. Keep it secret.
6. **App secret:** app → App settings → Basic → App secret → Show → this is `WA_APP_SECRET`.

## 4. Netlify environment variables

Site configuration → Environment variables, add:

| Name | Value |
|---|---|
| `WA_TOKEN` | the permanent token from step 3.5 |
| `WA_PHONE_NUMBER_ID` | from step 3.3 |
| `WA_VERIFY_TOKEN` | any secret text you make up, e.g. `ronch-acetech-2026` |
| `WA_APP_SECRET` | from step 3.6 |
| `LEADS_PASSWORD` | a password of your choice for the `/leads` page |
After adding or changing variables: **Deploys → Trigger deploy** — they only apply after a redeploy.

## 5. Connect the webhook

App → WhatsApp → **Configuration** → Webhook → Edit:

- Callback URL: `https://<your-site>.netlify.app/.netlify/functions/whatsapp`
- Verify token: the same text as `WA_VERIFY_TOKEN`
- Click Verify and save, then under Webhook fields **Subscribe** to `messages`.

## 6. Make the app Live

App → App settings → Basic: Privacy policy URL = `https://<your-site>.netlify.app/privacy.html`,
pick a category, save. Then switch **App mode** from Development to **Live**.
In Development mode Meta only sends test webhooks, so real visitors would get no reply.

## 7. Test, then print

1. From your personal phone, send "Hi" to the bot number. You should get the menu.
2. Pick Facade → the PDF arrives, followed by "More catalogues / Talk to sales".
3. Open `https://<your-site>/leads`, enter `LEADS_PASSWORD`: your test chats should be listed.
4. Open `https://<your-site>.netlify.app/whatsapp-qr.html`, type the bot number, print the poster.
   Test the printed QR with 2–3 different phones.

## What the bot understands

| Visitor sends | Bot does |
|---|---|
| Anything (first message) | Sends the menu; saves their message to the lead list |
| Picks a division | Sends that PDF + follow-up buttons |
| Picks "All catalogues" | Sends all five PDFs |
| "Talk to sales", or a message with *price / quote / call / sales* | Confirms a call back; marks the lead **Call back** |
| 1–5 typed as a number | Sends that division's PDF |
| STOP | Confirms opt-out; marks the lead **Opted out** |

If a PDF fails to deliver (for example a wrong file name), that lead is marked **Send failed** on the
lead list so someone can send it by hand.

## Lead list (`/leads`)

- Newest first: WhatsApp name, mobile (tap to call or open WhatsApp), catalogues sent, anything they typed,
  first and last contact time (IST), and tags for **Call back**, **Opted out**, **Send failed**.
- **Download CSV (Excel)** exports everything. Do this at the end of each show day.
- Check it a few times a day at the stand: visitors who tapped *Talk to sales* are waiting for your call.
- Visitors' typed messages appear only here; the bot number has no WhatsApp app to read chats in.
  To reply, call them or message them from a staff phone using the WhatsApp link.

## Troubleshooting

- **No reply at all:** app not Live, `messages` field not subscribed, or wrong Callback URL. Netlify →
  Logs → Functions → `whatsapp` shows each call.
- **401 in function logs:** `WA_APP_SECRET` is wrong.
- **Menu arrives but PDF doesn't:** open `https://<your-site>.netlify.app/catalogues/facade.pdf` in a
  browser; the file name must match `catalogues.json` exactly (case-sensitive).
- **Token error 190:** token expired or lacks permissions; regenerate the System User token (step 3.5).

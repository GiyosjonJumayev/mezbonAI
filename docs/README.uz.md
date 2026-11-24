# Mezbon AI

[English](../README.md)

Usta o‘zbekcha gapiradi. Mezbon uni 10 tilda bron qilinadigan taklifga aylantiradi.

![Bosh sahifa](screenshots/home.png)

## Ishga tushirish

Node.js 24 yoki yangiroq kerak.

```powershell
npm install
```

```powershell
npm start
```

| Sahifa | Kim uchun |
|---|---|
| http://localhost:4321 | Turist |
| http://localhost:4321/mezbon | Usta |
| http://localhost:4321/panel | Turizm qo‘mitasi, hokimlik |
| http://localhost:4321/qr | Mehmonxona |

Testlar: `npm test`. Bazani tozalash: serverni to‘xtating, keyin `npm run reset`.

## Sozlash

`.env.example` nusxasini `.env` deb nomlang. `.env` GitHub’ga yuklanmaydi.

- **`ANTHROPIC_API_KEY`**: haqiqiy AI matn va tarjima. Bo‘lmasa **demo rejim**: faktlar qoidalar bilan ajratiladi, matn shablondan olinadi.
- **`MEZBON_OFFLINE=1`**: zalda internet bo‘lmasa, demo rejimni majburlaydi.
- **`HOST=0.0.0.0`**: telefonlar bir xil Wi-Fi orqali kiradi. HTTPS yo‘q, shuning uchun faqat demo vaqtida yoqing.
- **`TELEGRAM_BOT_TOKEN`**: bot alohida oynada `npm run telegram` bilan ishlaydi.

## 3 daqiqalik demo

1. `/mezbon` ni Chrome’da oching, ism yozing, mikrofonni bosib gapiring. Mikrofon ishlamasa: **Namuna matn**.
2. **Taklifni tayyorlash**, tillarni almashtirib ko‘rsating, **E’lon qilish**.
3. Telefondan mehmonxona QR kodini skanerlang, xitoychani tanlab bron qiling, sinov to‘lovini bosing.
4. Usta ekranida bron chiqadi va ovoz eshitiladi. Mehmon xitoycha so‘raydi, usta o‘zbekcha javob beradi.
5. `/?region=surxondaryo` ni oching (bo‘sh), keyin `/panel`: talab bor, taklif yo‘q.
6. AI yordamchiga: “Farg‘onada kulolchilik darsini top va joy ushlab tur”.

Demo oldidan Claude kaliti bilan vaqtni o‘lchang. “60 soniya”ni faqat o‘lchagandan keyin ayting.

## Prototipda nima haqiqiy emas

- **To‘lov**: sinov tugmasi, pul yechilmaydi. Litsenziyali to‘lov hamkori kerak.
- **GetYourGuide, Viator, Klook**: ulanmagan. Faqat `/feeds/products.json` eksporti bor.
- **Namuna ma’lumot**: 4 ta mezbon, 3 ta mehmonxona, 96 ta qidiruv o‘ylab topilgan va belgilangan. `SEED=0` bilan o‘chiriladi.
- **Nutqni tanish**: brauzerniki (Chrome, internet kerak). Ovoz brauzer ishlab chiqaruvchisiga yuboriladi.
- **Ovozli o‘qish**: ko‘p qurilmalarda o‘zbek ovozi yo‘q, turkcha ovoz ishlatiladi.
- **Telegram ovozli xabarlari**: matnga aylantirilmaydi.
- **Tarjimalar**: til egalari tekshirmagan.
- **Kirish**: usta kabineti maxfiy havola bilan ochiladi. SMS tasdiq yo‘q.
- **Gid sertifikati**: raqami so‘raladi, reyestrdan tekshirilmaydi.

# SilkRoad Experience OS

**Har bir mahalliy tajriba. Bitta raqamli platforma.**

[English](../README.md)

Mahalliy turizm bizneslari uchun AI asosidagi raqamli tizim: hunarmandlar, oilaviy mehmon uylari, tajriba tashkilotchilari. O‘zbekcha gapirasiz, mehmonlar 10 tilda o‘qiydi va bron qiladi.

## Imkoniyatlar

- **Ko‘p tilli taklif**: ovoz yoki matndan 10 tilda.
- **Bronlar**: jonli xabar, qabul qilish, tarjimali yozishma.
- **Kalendar**: har bir vaqtni alohida yopish, joyni kamaytirish yoki ko‘paytirish. Mavjud bronlar saqlanadi.
- **QR chipta**: tasdiqlangan bronga beriladi, o‘z kunida bir marta ishlaydi.
- **Daromad tahlili**: davr, taklif, kanal, til kesimi, CSV.
- **Bozor tahlili**: narxlar taqqosi, javobsiz talab, tavsiyalar.
- **Tariflar**: Bepul (12% komissiya, 3 taklif), Pro (149 000 so‘m, 8%), Business (490 000 so‘m, 6%). Narxlar taxminiy: `src/business.mjs` dagi `PLANS` da o‘zgaradi.

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
| http://localhost:4321/mezbon | Mahalliy biznes |
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
4. Usta ekranida bron chiqadi va ovoz eshitiladi. Usta qabul qiladi, mehmonda QR chipta paydo bo‘ladi. **Chiptalar** bo‘limida kodni tekshiring (faqat tashrif kuni qabul qilinadi).
5. **Tarif** bo‘limida sinov obunasini yoqing, **Daromad** va **Bozor tahlili**ni ko‘rsating.
6. `/?region=surxondaryo` ni oching (bo‘sh), keyin `/panel`: talab bor, taklif yo‘q.
7. AI yordamchiga: “Farg‘onada kulolchilik darsini top va joy ushlab tur”.

Demo oldidan Claude kaliti bilan vaqtni o‘lchang. “60 soniya”ni faqat o‘lchagandan keyin ayting.

## Prototipda nima haqiqiy emas

- **To‘lov va obuna**: sinov tugmasi, pul yechilmaydi. Litsenziyali to‘lov hamkori kerak.
- **GetYourGuide, Viator, Klook**: ulanmagan. Faqat `/feeds/products.json` eksporti bor.
- **Namuna ma’lumot**: 4 ta mezbon, 3 ta mehmonxona, 96 ta qidiruv o‘ylab topilgan va belgilangan. `SEED=0` bilan o‘chiriladi.
- **Nutqni tanish**: brauzerniki (Chrome, internet kerak). Ovoz brauzer ishlab chiqaruvchisiga yuboriladi.
- **Ovozli o‘qish**: ko‘p qurilmalarda o‘zbek ovozi yo‘q, turkcha ovoz ishlatiladi.
- **Telegram ovozli xabarlari**: matnga aylantirilmaydi.
- **Tarjimalar**: til egalari tekshirmagan.
- **Tunash**: mehmon uyida tunash broni yo‘q, faqat tajribalar (kechki ovqat, master-klass) sotiladi.
- **Kamera skaneri**: haqiqiy telefonda sinalmagan, HTTPS kerak. Telefonning o‘z kamerasi yoki kodni qo‘lda kiritish ham ishlaydi.
- **Kirish**: usta kabineti maxfiy havola bilan ochiladi. SMS tasdiq yo‘q.
- **Gid sertifikati**: raqami so‘raladi, reyestrdan tekshirilmaydi.

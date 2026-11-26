# SilkRoad Experience OS 8.0

**AI-powered Tourism Business Operating System**

[English](../README.md)

Oddiy marketplace emas. Bu mahalliy turizm bizneslarini raqamlashtiradigan, ularning xizmatlarini sotishga va daromadini oshirishga yordam beradigan tizim.

## Uchta asosiy ustunlik

1. **AI Business Assistant**: kichik biznesga professional raqamli xizmat yaratish va boshqarish imkonini beradi.
   - Ovoz yoki matndan 10 tilli taklif.
   - Suhbat: daromad, jadval, narx, talab haqida o‘z raqamlaringiz bilan javob. O‘zgarishni taklif qiladi, siz tasdiqlaysiz.
   - Bugungi ishlar va tashriflar, har bir taklifning tayyorlik bali.
2. **Smart Experience Booking**: xizmat, vaqt, sig‘im, bron va QR check-in.
   - Har bir vaqtni alohida yopish yoki kengaytirish. Mavjud bronlar saqlanadi.
   - Mehmon 24 soat oldin vaqtni ko‘chiradi yoki bekor qiladi.
   - Bir martalik QR chipta, tarjimali yozishma.
3. **Tourism Intelligence**: talab va biznes natijalari.
   - Daromad, konversiya, eng band vaqtlar, kelmaganlar, CSV.
   - Narx taqqosi, javobsiz talab, turistlar qidirgan sanalar va tillar.

## 8.0 da yangi

- **Hammasi jonli**: bo‘sh joy, taklif, bron, talab paneli va ta’sir sahifasi ochiq ekranda o‘zi yangilanadi. Oqimda shaxsiy ma’lumot yo‘q.
- **Tezkor qidiruv**: har bir harfdan keyin natija, 10 tilda; tur va hudud bo‘yicha son, tezkor kunlar, narx chegarasi. Kun band bo‘lsa, yaqin bo‘sh kunlar taklif qilinadi.
- **Eng yaqin bo‘sh vaqt**: har bir kartada vaqt, qolgan joy va o‘sha vaqtdagi narx.
- **Moslashuvchan narx**: dam olish kuni, oxirgi daqiqa va guruh narxi. Saqlashdan oldin natija ko‘rinadi. Narx oshsa, mehmon qayta rozilik beradi.
- **Kutish ro‘yxati**: joy ochilsa, mehmonga bir marta xat boradi. Mezbon necha kishi kutayotganini ko‘radi va bir bosishda joy ochadi.
- **Mezbon kuni**: yaqin tashriflar, qolgan vaqt, bronlarni saralash va qidirish.

## 7.0 da

- **Niyat xati** (`/hamkor`): usta, mehmonxona yoki hamkor xatni o‘qib, narx va rozi bo‘ladigan komissiyasi bilan imzolaydi. Ma’mur qo‘ng‘iroq qilib tasdiqlaydi, faqat tasdiqlangani sanaladi.
- **Jonli sahna** (`/stage`): sayyoh, usta va ochiq natija bitta ekranda, haqiqatan bog‘langan. O‘zbekcha yoki inglizcha, taqdimot pulti bilan, faqat namoyishda.
- **Ochiq namoyish**: `render.yaml` namuna ma’lumotli saytni internetga qo‘yadi. Haqiqiy to‘lov kaliti bilan ishlamaydi.

## 6.0 da

- **Click** to‘lovi: Octo va Payme yoniga uchinchi tizim, pul qaytarish bilan.
- **Sayohat uchun bitta to‘lov**: bir mezbon qabul qila olmasa, faqat uning puli qaytadi.
- **Manzil va telefon**: faqat tasdiqlangan mehmonga, xarita bilan.
- **Email**: chek, tasdiq, eslatma, bronni topish, kirish havolasi.
- **O‘z valyutasida narx**: Markaziy bank kursi bo‘yicha, to‘lov so‘mda.
- **`/impact`**: sayyoh pulining qanchasi mahalliy oilalarga yetgani ochiq.
- **Investor ko‘rsatkichlari**: `/admin` da, faqat haqiqiy to‘lovlardan.
- **`npm run doctor`** va [ishga tushirish qo‘llanmasi](LAUNCH.md).

## 5.0 da

- **PostgreSQL**: pul va joyni himoya qiladigan qoidalar bazaning o‘zida ham tekshiriladi.
- **Haqiqiy to‘lov**: Octo (Visa, Mastercard, Uzcard, Humo) va Payme, pul qaytarish, obuna, o‘tkazmalar hisobi.
- **Sayohat rejasi**: faqat haqiqatan bo‘sh joylardan yo‘nalish tuzadi, hammasini birga band qiladi yoki hech birini.
- **Passkey**: kabinetga barmoq izi, yuz yoki PIN bilan kiriladi, parol yo‘q.
- **Ma’muriyat** (`/admin`): mezbonni tekshirish, shikoyatlar, qaytarishlar, o‘tkazmalar, o‘chirib bo‘lmaydigan jurnal.
- **Ishonch**: mezbon sahifasi, javob vaqti, “Tekshirilgan” belgisi. Mezbon 24 soatda javob bermasa, pul o‘zi qaytadi.

**Tariflar**: Bepul (12% komissiya, 3 taklif, kuniga 15 AI xabar), Pro (149 000 so‘m, 8%, 100), Business (490 000 so‘m, 6%, 300). Narxlar taxminiy: `src/domain/plans.mjs` da o‘zgaradi.

![Bosh sahifa](screenshots/home.png)

## Ishga tushirish

[Node.js 24+](https://nodejs.org) va [PostgreSQL](https://www.postgresql.org/download/) o‘rnatilgan bo‘lishi kerak (18 da sinalgan).

```powershell
npm install
```

```powershell
npm run db:local
```

```powershell
npm start
```

`npm run db:local` loyiha uchun alohida baza ochadi: o‘z papkasi, porti va tasodifiy parollari bor, boshqa bazalaringizga tegmaydi.

| Sahifa | Kim uchun |
|---|---|
| http://localhost:4321 | Turist |
| http://localhost:4321/mezbon | Mahalliy biznes |
| http://localhost:4321/panel | Turizm qo‘mitasi, hokimlik |
| http://localhost:4321/qr | Mehmonxona |
| http://localhost:4321/admin | Ma’muriyat (`.env` da `ADMIN_KEY` kerak) |

**Taqdimot uchun**: `npm run demo` bir oylik namuna faoliyat bilan alohida bazada, 4322-portda ochiladi va barcha havolalarni ko‘rsatadi.

Testlar: `npm test`. Zaxira: `npm run backup -- --verify`.

## To‘lovni ulash

1. Octo yoki Payme bilan savdogar shartnomasi tuzing va kalitlarni oling.
2. Sayt `https://` manzilda ishlashi kerak (`compose.yaml` sertifikatni o‘zi oladi).
3. `.env` ga `OCTO_SHOP_ID` va `OCTO_SECRET` yoki `PAYME_MERCHANT_ID` va `PAYME_KEY` yozing. Payme kabinetida manzil: `https://domeningiz/pay/payme`, hisob maydoni: `order_id`.
4. Sinov to‘lovi o‘zi o‘chadi.

Karta ma’lumoti bu serverga kelmaydi. Server hech kimga pul yubormaydi: mezbonlarga o‘tkazma bankda qilinadi va `/admin` da yoziladi.

Barcha sozlamalar: [.env.example](../.env.example). Xavfsizlik: [SECURITY.md](../SECURITY.md).

## 3 daqiqalik demo

`npm run demo` ni ishga tushiring va chiqqan havolalardan foydalaning.

1. Sayohatchi sahifasida **Sayohat rejasi**: “5 kun, 2 kishi, Samarqand va Buxoro, oshpazlik” deb yozing. Yo‘nalish chiqadi, hammasini band qiling.
2. Bitta bronni oching, sinov to‘lovini bosing. Ustada bron chiqadi va ovoz eshitiladi. Usta qabul qiladi, mehmonda QR chipta paydo bo‘ladi.
3. Boshqa bronni bekor qiling: pul qaytgani ko‘rinadi.
4. Kabinetda mikrofonni bosib yangi taklif yarating (mikrofon ishlamasa: **Namuna matn**), 10 tilni ko‘rsating, **E’lon qilish**.
5. **AI yordamchi**da “narxni 180 ming qil” deng va tasdiqlang. **Daromad** va **Bozor tahlili**ni ko‘rsating.
6. `/admin` da mezbonni tekshiring, shikoyat va jurnalni ko‘rsating.
7. `/panel`: talab bor, taklif yo‘q hududlar.

Demo oldidan Claude kaliti bilan vaqtni o‘lchang. “60 soniya”ni faqat o‘lchagandan keyin ayting.

## Tashqi dunyodan nima kerak

- **To‘lov shartnomasi**: Octo va Payme ularning hujjatlari bo‘yicha yozilgan va mahalliy sinov serverida tekshirilgan, haqiqiy xizmatda hali emas. Click ham shunday. Shartnoma, kalitlar va ularning qabul sinovi kerak.
- **Docker va Caddy** ishlab chiquvchi kompyuterida ishga tushirib ko‘rilmagan, GitHub CI konteynerni ishga tushiradi.
- **Claude** haqiqiy API bilan hali sinalmagan. Kalitsiz yordamchi va sayohat rejasi faqat tayyor iboralarni tushunadi.
- **Push, email va Telegram** sinov jo‘natuvchi bilan tekshirilgan. HTTPS va bot tokeni kerak.
- **Rasmlar** avtomatik naqsh, haqiqiysini mezbon yuklaydi.
- **Nutqni tanish** brauzerniki (Chrome, internet kerak). Ovoz brauzer ishlab chiqaruvchisiga yuboriladi.
- **Tarjimalar**ni til egalari tekshirmagan.
- **“Tekshirilgan” belgisi va gid sertifikati** ma’mur hujjatni haqiqatan ko‘rishiga bog‘liq, reyestr bilan aloqa yo‘q.
- **Tunash** broni yo‘q. **GetYourGuide, Viator, Klook** ulanmagan, faqat `/feeds/products.json` bor.
- **Qonun**: shartnoma, soliq, fiskal chek va shaxsiy ma’lumotni O‘zbekistonda saqlash bo‘yicha yurist maslahati kerak.

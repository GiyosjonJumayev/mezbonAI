# Ishga tushirish qo‘llanmasi

Saytni haqiqiy mehmonlar uchun ochish tartibi. Har bir qadamdan keyin `npm run doctor` nima tayyor, nima yo‘qligini aytadi.

## 0. Avval namoyish va niyat xatlari

Haqiqiy saytdan oldin ochiq namoyish qo‘yish mumkin: Render’da `render.yaml` (bepul, 30 kundan keyin bazasi o‘chadi). Unda faqat namuna ma’lumot va sinov to‘lovi bor. **Niyat xatlarini namoyishda emas, o‘z serveringizda yig‘ing**: namoyish bazasi o‘chib ketadi.

1. Usta va mehmonxonalarga `/hamkor` havolasini bering yoki yonida o‘tirib birga to‘ldiring.
2. `/admin` da “Niyat xatlari”: qo‘ng‘iroq qiling, keyin “Tasdiqlash”ni bosing.
3. Xat shartnoma emas. Taqdimotda ism ko‘rsatish uchun alohida ruxsat oling.

## 1. Server va domen

1. Docker o‘rnatilgan Linux server va domen oling. Domenni server IP manziliga yo‘naltiring.
2. Loyihani serverga yuklang va `.env.example` dan `.env` yarating.
3. To‘ldiring: `SITE_DOMAIN`, `DB_OWNER_PASSWORD`, `DB_APP_PASSWORD`, `ADMIN_KEY` (har biri `openssl rand -hex 24`).
4. `docker compose up -d`. HTTPS sertifikatini Caddy o‘zi oladi.

Shaxsiy ma’lumotni O‘zbekistondagi serverda saqlash talabi bo‘yicha yurist bilan gaplashing.

## 2. Ma’muriyat

1. `npm run admin:totp` QR kod beradi. Uni autentifikator ilovasida skanerlang, `ADMIN_TOTP` ni `.env` ga yozing.
2. `/admin` ga kalit va 6 xonali kod bilan kiring.

## 3. To‘lov

Kamida bittasi yetarli. Kalit yozilgach, sinov to‘lovi o‘zi o‘chadi.

| | Nima kerak | `.env` | Ularning kabinetiga yoziladigan manzil |
|---|---|---|---|
| **Octo**: Visa, Mastercard, Uzcard, Humo | Shartnoma, do‘kon raqami, maxfiy kalit | `OCTO_SHOP_ID`, `OCTO_SECRET`; avval `OCTO_TEST=1` | kerak emas, har to‘lov bilan yuboriladi |
| **Click**: Uzcard, Humo | Shartnoma, xizmat raqami | `CLICK_SERVICE_ID`, `CLICK_MERCHANT_ID`, `CLICK_MERCHANT_USER_ID`, `CLICK_SECRET` | Prepare va Complete: `https://domen/pay/click` |
| **Payme**: Uzcard, Humo | Shartnoma, kassa | `PAYME_MERCHANT_ID`, `PAYME_KEY`; avval `PAYME_TEST=1` | `https://domen/pay/payme`, hisob maydoni `order_id` |

Xorijiy mehmonlar uchun Octo kerak: Click va Payme mahalliy kartalar uchun.

Har bir kompaniya o‘z qabul sinovini o‘tkazadi. Keyin o‘zingiz kichik summada bitta to‘lov qiling, uni bekor qiling va pul qaytganini tekshiring.

Fiskal chek kerak bo‘lsa, buxgalter bilan `FISCAL_INN`, `FISCAL_SPIC`, `FISCAL_PACKAGE`, `FISCAL_VAT` ni aniqlang.

**Pul qaytarish**: Octo to‘liq yoki qisman, Click to‘liq (o‘sha oy ichida) avtomatik qaytaradi. Payme puli uning kabinetida qaytariladi, tizim buni o‘zi biladi. Qolganlari `/admin` da ko‘rinadi.

**Mezbonlarga to‘lov**: `/admin` “To‘lashga tayyor” summani ko‘rsatadi. Bankda o‘tkazing, hujjat raqamini yozing. Server pul yubormaydi.

## 4. Email va Telegram

- `SMTP_URL` va `MAIL_FROM`: chek, tasdiq, eslatma, bronni topish, mezbonning kirish havolasi. Masalan `smtps://foydalanuvchi:parol@smtp.domen.uz:465`.
- `TELEGRAM_BOT_TOKEN`: @BotFather dan. Mezbonlar botda bronni qabul qiladi, `/kirish` bilan kabinetga kiradi.

## 5. Sun’iy intellekt

`ANTHROPIC_API_KEY` bo‘lmasa, matn shablondan olinadi va erkin yozishma tarjima qilinmaydi.

## 6. Kontent

1. 10–15 ta haqiqiy mezbon bilan shartnoma tuzing, hujjatini ko‘ring, `/admin` da “Tekshirildi” ni bosing.
2. Har biri: kamida 3 ta haqiqiy rasm, aniq manzil va xaritadagi nuqta, telefon, passkey.
3. Tarjimalarni til egalariga o‘qiting.
4. `SEED=0` yoki `NODE_ENV=production`: namuna takliflar qo‘shilmaydi.

## 7. Ochishdan oldin

- `npm run doctor` da xato yo‘q.
- `npm run backup -- --verify` o‘tdi va har kuni avtomatik ishlaydi, nusxasi boshqa joyda.
- Telefonda: mehmon sifatida bron, to‘lov, chipta; mezbon sifatida qabul va QR skaner.
- Ommaviy oferta, maxfiylik siyosati va qaytarish qoidalari yurist bilan yozilgan.

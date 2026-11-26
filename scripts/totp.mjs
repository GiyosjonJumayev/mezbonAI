// Makes the secret for two-step administrator sign-in.   npm run admin:totp
import QRCode from "qrcode";
import { newTotpSecret } from "../src/lib/totp.mjs";

const secret = newTotpSecret(), uri = `otpauth://totp/SilkRoad%20admin?secret=${secret}&issuer=SilkRoad`;
console.log(await QRCode.toString(uri, { type: "terminal", small: true }));
console.log(`Autentifikator ilovasida QR kodni skanerlang, keyin .env fayliga yozing va serverni qayta ishga tushiring:\n\nADMIN_TOTP=${secret}\n`);

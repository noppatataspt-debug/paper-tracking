# Paper Tracker — Refactored Structure (Step 1)

ระบบติดตามการใช้กระดาษในการผลิต — หลังจากแยก CSS/JS ออกจาก HTML แล้ว

## 📁 โครงสร้างไฟล์

```
paper-tracker/
├── index.html              หน้าบันทึกข้อมูล (สแกน barcode)
├── dashboard.html          หน้า Dashboard (trace, lot lookup, invoice, edit, stats)
├── vercel.json             ตั้งค่า Vercel (headers, clean URLs)
├── README.md               ไฟล์นี้
├── css/
│   ├── index.css           สไตล์หน้า index
│   └── dashboard.css       สไตล์หน้า dashboard
└── js/
    ├── config.js           ⭐ Supabase URL + anon key (ที่เดียว)
    ├── scanner.js          Logic หน้าบันทึก
    └── dashboard.js        Logic หน้า Dashboard
```

## 🔄 เปรียบเทียบก่อน-หลัง Refactor

| ไฟล์ | ก่อน | หลัง | ลดลง |
|------|------|------|------|
| index.html | 1,961 บรรทัด | 217 บรรทัด | -89% |
| dashboard.html | 3,903 บรรทัด | 357 บรรทัด | -91% |

## 🚀 วิธี Deploy

### ครั้งแรก (ถ้ายังไม่มี repo)
```bash
git init
git add .
git commit -m "Refactor: แยก CSS/JS ออกจาก HTML"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/paper-tracker.git
git push -u origin main
```
แล้ว import repo ใน Vercel Dashboard

### update ครั้งต่อไป
```bash
git add .
git commit -m "message"
git push
```
Vercel จะ auto-deploy ให้อัตโนมัติ

## ✅ สิ่งที่ได้จาก Refactor นี้

1. **HTML สะอาด** — อ่านง่าย ดู structure ของหน้าได้ทันที
2. **Config ที่เดียว** — เปลี่ยน Supabase key ครั้งเดียวใน `js/config.js`
3. **Browser cache ดีขึ้น** — CSS/JS แยกไฟล์ cache ได้
4. **แก้ไขง่าย** — หา bug ง่ายขึ้น ไม่ต้อง scroll ผ่าน CSS
5. **พร้อมทำงานทีม** — หลายคนแก้ไฟล์คนละตัวได้พร้อมกัน ไม่ชนกัน

## ⚠️ สิ่งที่ยังต้องทำ (Step 2 ถัดไป)

- [ ] ย้ายไป **Next.js** — จะได้ API routes (Backend layer)
- [ ] ซ่อน **Supabase anon key** ด้วย env variable
- [ ] เพิ่ม **Zod schema validation** — ทั้ง UI และ API ใช้ schema เดียวกัน
- [ ] เตรียม endpoint `/api/agent/*` สำหรับ Phase 2 (Multi-agent)

## 🔐 Security Notes

ปัจจุบัน anon key อยู่ใน `js/config.js` ซึ่ง browser เห็นได้ 
การป้องกันพึ่ง **Supabase RLS (Row Level Security)** อย่างเดียว

ตรวจสอบให้แน่ใจว่า RLS policies ใน Supabase ถูกตั้งค่า:
- table ทุกตัวมี RLS enabled
- policy จำกัดสิทธิ์ read/write ตาม role
- Service role key **ห้าม** อยู่ในไฟล์ client-side เด็ดขาด

## 🧪 ทดสอบก่อน Deploy

เปิด terminal ที่โฟลเดอร์ paper-tracker แล้วรัน:

```bash
# ถ้ามี Python
python3 -m http.server 8000

# หรือถ้ามี Node
npx serve .
```

แล้วเปิด `http://localhost:8000` ทดสอบทุก feature ว่าทำงานเหมือนเดิม:

- [ ] index.html — สแกน barcode, บันทึก batch
- [ ] dashboard.html — login, trace, lot lookup, invoice, history, edit, stats, access log

---

**เวอร์ชัน:** Refactor Step 1 of 3
**ขั้นถัดไป:** Step 2 (Next.js migration) — ดูใน task tracker

const admin = require('firebase-admin');

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error('ERROR: Secret FIREBASE_SERVICE_ACCOUNT belum diatur di GitHub Secrets.');
  process.exit(1);
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
const databaseURL =
  process.env.FIREBASE_DATABASE_URL ||
  'https://e-absenpkmbarugaia-default-rtdb.asia-southeast1.firebasedatabase.app/';

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: databaseURL,
});

const db = admin.database();

function normalizeNip(raw) {
  return String(raw || '').replace(/[\s\-\.]/g, '').trim();
}

function getWitaDateInfo() {
  const now = new Date();
  // Format YYYY-MM-DD sesuai getLocalDateStr() di index.html
  const dateStr = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Makassar' });

  // Format jam HH:MM:SS WITA
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Makassar',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(now);
  const timeStr = `${parts} WITA`;

  // Cek hari dalam zona waktu WITA
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Makassar',
    weekday: 'short',
  }).format(now);

  return { dateStr, timeStr, isSunday: weekday === 'Sun' };
}

async function runAutoAbsen() {
  const { dateStr, timeStr, isSunday } = getWitaDateInfo();
  console.log(`[${dateStr} ${timeStr}] Memulai pengecekan presensi ASN UPT Puskesmas Barugaia...`);

  try {
    // 1. Cek Hari Libur (Minggu atau daftar di node 'holidays')
    if (isSunday) {
      await db.ref('system_status/last_cron_execution').set({
        status: 'SKIPPED_HOLIDAY',
        date: dateStr,
        reason: 'Hari Minggu (Libur Rutin)',
        updatedAt: timeStr,
      });
      console.log(`Dilewati: ${dateStr} adalah Hari Minggu.`);
      process.exit(0);
    }

    const holidaysSnap = await db.ref('holidays').once('value');
    const holidaysData = holidaysSnap.val();
    const holidaysList = holidaysData ? Object.values(holidaysData) : [];
    const matchedHoliday = holidaysList.find((h) => String(h.date || '').trim() === dateStr);

    if (matchedHoliday) {
      const reason = matchedHoliday.desc || 'Hari Libur Nasional / Cuti Bersama';
      await db.ref('system_status/last_cron_execution').set({
        status: 'SKIPPED_HOLIDAY',
        date: dateStr,
        reason: reason,
        updatedAt: timeStr,
      });
      console.log(`Dilewati: ${dateStr} tercatat sebagai hari libur (${reason}).`);
      process.exit(0);
    }

    // 2. Ambil Master Data Pegawai ('employees')
    const employeesSnap = await db.ref('employees').once('value');
    const employeesData = employeesSnap.val();
    const employees = employeesData ? Object.values(employeesData).filter(Boolean) : [];

    if (employees.length === 0) {
      console.warn('Data master pegawai di node "employees" kosong. Tidak ada proses dijalankan.');
      process.exit(0);
    }

    // 3. Ambil Log Presensi Hari Ini ('attendance_logs')
    const logsSnap = await db.ref('attendance_logs').once('value');
    const logsData = logsSnap.val();
    const allLogs = logsData ? Object.values(logsData).filter(Boolean) : [];

    // Kumpulkan NIP yang sudah punya catatan hari ini (baik Reguler maupun Jaga/Izin/Sakit/DL/Cuti/Alpa)
    const recordedNipsToday = new Set(
      allLogs
        .filter((log) => String(log.date || '').trim() === dateStr)
        .map((log) => normalizeNip(log.nip))
    );

    // 4. Siapkan log ALPA bagi pegawai yang belum memiliki catatan sama sekali hari ini
    const updates = {};
    const baseTimestamp = Date.now() * 1000;
    let seq = 1;
    let alpaCount = 0;

    for (const emp of employees) {
      const cleanNip = normalizeNip(emp.nip);
      if (!cleanNip || recordedNipsToday.has(cleanNip)) {
        continue;
      }

      const logId = baseTimestamp + seq++;
      updates[String(logId)] = {
        id: logId,
        category: 'REGULER',
        shift: '-',
        date: dateStr,
        time: timeStr,
        nip: cleanNip,
        nip_display: emp.nip_display || cleanNip,
        nama: emp.nama,
        jabatan: emp.jabatan || '-',
        unit: emp.unit || '-',
        type: 'ALPA',
        status: 'TIDAK HADIR (ALPA)',
        isBypass: false,
        method: 'System Actions Cron',
      };
      alpaCount++;
    }

    if (alpaCount > 0) {
      await db.ref('attendance_logs').update(updates);
      console.log(`Berhasil mencatat ${alpaCount} pegawai dengan status TIDAK HADIR (ALPA) untuk tanggal ${dateStr}.`);
    } else {
      console.log(`Seluruh ${employees.length} pegawai sudah memiliki catatan presensi pada ${dateStr}.`);
    }

    // 5. Perbarui status cron agar indikator di header index.html otomatis berubah menjadi Active
    await db.ref('system_status/last_cron_execution').set({
      status: 'SUCCESS',
      date: dateStr,
      alpaCount: alpaCount,
      totalEmployees: employees.length,
      updatedAt: timeStr,
    });

    console.log('Sinkronisasi status Med-Sync Cron selesai.');
    process.exit(0);
  } catch (err) {
    console.error('Gagal menjalankan Auto-Absen:', err);
    process.exit(1);
  }
}

runAutoAbsen();

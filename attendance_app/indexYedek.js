const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const fs = require("fs");
const bodyParser = require("body-parser");
const path = require("path");
const PDFDocument = require("pdfkit");

const app = express();
const PORT = 3000;

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.static("public"));

const db = new sqlite3.Database("attendance.db");

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_no TEXT,
    first_name TEXT,
    last_name TEXT,
    class_name TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER,
    date TEXT,
    lesson_hour TEXT,
    status TEXT,
    FOREIGN KEY(student_id) REFERENCES students(id)
  )`);
});

function loadStudentsIfEmpty() {
  db.get("SELECT COUNT(*) as count FROM students", (err, row) => {
    if (row.count === 0) {
      const lines = fs.readFileSync("students.txt", "utf8").split("\n");
      const stmt = db.prepare("INSERT INTO students (student_no, first_name, last_name, class_name) VALUES (?, ?, ?, ?)");
      for (const line of lines) {
        const [no, first, last, className] = line.split(",");
        stmt.run(no, first, last, className);
      }
      stmt.finalize();
    }
  });
}

loadStudentsIfEmpty();

// Sayfa yönlendirmeleri
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});
app.get("/query", (req, res) => {
  res.sendFile(path.join(__dirname, "public/query.html"));
});
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public/admin.html"));
});
app.get("/student-query", (req, res) => {
  res.sendFile(path.join(__dirname, "public/student_query.html"));
});

// API endpoint'leri
app.get("/classes", (req, res) => {
  db.all("SELECT DISTINCT class_name FROM students", (err, rows) => {
    res.json(rows.map(r => r.class_name));
  });
});

app.get("/students", (req, res) => {
  const className = req.query.class;
  db.all("SELECT * FROM students WHERE class_name = ?", [className], (err, rows) => {
    res.json(rows);
  });
});

/*
// Backend güncellemesi: Basit kayıt (kontrolsüz)
app.post("/attendance", (req, res) => {
  const { date, lesson_hour, class_name, absentees } = req.body;
  db.all("SELECT id FROM students WHERE class_name = ?", [class_name], (err, students) => {
    const stmt = db.prepare("INSERT INTO attendance (student_id, date, lesson_hour, status) VALUES (?, ?, ?, ?)");
    students.forEach(s => {
      const status = absentees.includes(s.id.toString()) ? "absent" : "present";
      stmt.run(s.id, date, lesson_hour, status);
    });
    stmt.finalize(() => {
      res.json({ success: true });
    });
  });
});
*/

/*
app.post("/attendance", (req, res) => {
  const { date, lesson_hour, class_name, absentees } = req.body;

  db.all("SELECT id FROM students WHERE class_name = ?", [class_name], (err, students) => {
    const stmt = db.prepare("INSERT INTO attendance (student_id, date, lesson_hour, status) VALUES (?, ?, ?, ?)");
    let completed = 0;
    let inserted = 0;

    students.forEach(s => {
      const status = absentees.includes(s.id.toString()) ? "absent" : "present";

      db.get("SELECT 1 FROM attendance WHERE student_id = ? AND date = ? AND lesson_hour = ?", [s.id, date, lesson_hour], (err, row) => {
        if (!row) {
          stmt.run(s.id, date, lesson_hour, status, () => {
            inserted++;
            done();
          });
        } else {
          done();
        }

        function done() {
          completed++;
          if (completed === students.length) {
            stmt.finalize(() => {
              if (inserted === 0) {
                res.status(400).json({ success: false, message: "Bu tarih ve ders saati için tüm öğrenciler zaten yok yazılmış." });
              } else {
                res.json({ success: true });
              }
            });
          }
        }
      });
    });
  });
});
*/

app.post("/attendance", (req, res) => {
  const { date, lesson_hour, class_name, absentees } = req.body;

  if (!absentees || absentees.length === 0) {
    return res.status(400).json({ success: false, message: "Hiç öğrenci seçilmedi." });
  }

  let placeholders = absentees.map(() => '?').join(',');
  let params = [...absentees, date, lesson_hour];

  db.all(
    `SELECT student_id FROM attendance 
     WHERE student_id IN (${placeholders}) AND date = ? AND lesson_hour = ?`,
    params,
    (err, rows) => {
      if (rows && rows.length > 0) {
        return res.status(400).json({
          success: false,
          message: "Seçilen öğrencilerden en az biri için bu tarih ve ders saati zaten girilmiş."
        });
      }

      const stmt = db.prepare("INSERT INTO attendance (student_id, date, lesson_hour, status) VALUES (?, ?, ?, ?)");

      absentees.forEach(studentId => {
        stmt.run(studentId, date, lesson_hour, "absent");
      });

      stmt.finalize(() => {
        res.json({ success: true });
      });
    }
  );
});










app.get("/attendance-query", (req, res) => {
  const { date, class_name } = req.query;
  db.all(`
    SELECT s.student_no, s.first_name, s.last_name, a.status, a.lesson_hour 
    FROM attendance a
    JOIN students s ON s.id = a.student_id
    WHERE a.date = ? AND s.class_name = ?
  `, [date, class_name], (err, rows) => {
    res.json(rows);
  });
});

app.get("/attendance-pdf", (req, res) => {
  const { date, class_name } = req.query;
  db.all(`
    SELECT s.student_no, s.first_name, s.last_name, a.status, a.lesson_hour 
    FROM attendance a
    JOIN students s ON s.id = a.student_id
    WHERE a.date = ? AND s.class_name = ?
  `, [date, class_name], (err, rows) => {
    const doc = new PDFDocument();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=\"attendance.pdf\"");
    doc.pipe(res);
    doc.fontSize(16).text(`Yoklama Listesi - ${class_name} (${date})`, { underline: true });
    doc.moveDown();
    rows.forEach(r => {
      doc.text(`${r.student_no} - ${r.first_name} ${r.last_name} [${r.lesson_hour}]: ${r.status}`);
    });
    doc.end();
  });
});

app.post("/student-add", (req, res) => {
  const { student_no, first_name, last_name, class_name } = req.body;
  db.run("INSERT INTO students (student_no, first_name, last_name, class_name) VALUES (?, ?, ?, ?)",
    [student_no, first_name, last_name, class_name], err => {
      res.json({ success: !err });
    });
});

app.get("/student-delete", (req, res) => {
  const id = req.query.id;
  db.run("DELETE FROM students WHERE id = ?", [id], err => {
    res.json({ success: !err });
  });
});

app.get("/all-students", (req, res) => {
  db.all("SELECT * FROM students", (err, rows) => {
    res.json(rows);
  });
});

// GÜNCELLENMİŞ BACKEND: /student-absences endpoint'i ders saatleriyle birlikte
app.get("/student-absences", (req, res) => {
  const student_no = req.query.student_no;
  db.get("SELECT id FROM students WHERE student_no = ?", [student_no], (err, student) => {
    if (!student) return res.json({ found: false });
    db.all("SELECT date, lesson_hour FROM attendance WHERE student_id = ? AND status = 'absent'", [student.id], (err, records) => {
      const grouped = {};
      records.forEach(r => {
        if (!grouped[r.date]) grouped[r.date] = [];
        grouped[r.date].push(r.lesson_hour);
      });
      const dates = Object.keys(grouped).map(date => ({ date, hours: grouped[date] }));
      res.json({
        found: true,
        total: records.length,
        dates
      });
    });
  });
});


app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});

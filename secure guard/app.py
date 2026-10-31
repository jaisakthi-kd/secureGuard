import csv
import io
import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path

from flask import Flask, Response, jsonify, render_template, request


BASE_DIR = Path(__file__).resolve().parent
DATABASE = Path(os.environ.get("SECUREGUARD_DB", BASE_DIR / "secureguard.db"))
app = Flask(__name__)


@contextmanager
def get_db():
    connection = sqlite3.connect(DATABASE)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def risk_level(score):
    if score <= 30:
        return "Low"
    if score <= 60:
        return "Medium"
    return "High"


def initialize_db():
    with get_db() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS login_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                ip_address TEXT NOT NULL,
                location TEXT NOT NULL,
                device TEXT NOT NULL,
                login_time TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('Success', 'Failed')),
                failed_attempts INTEGER NOT NULL DEFAULT 0,
                risk_score INTEGER NOT NULL DEFAULT 0,
                risk_level TEXT NOT NULL DEFAULT 'Low',
                reasons TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS alerts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id INTEGER NOT NULL REFERENCES login_events(id) ON DELETE CASCADE,
                title TEXT NOT NULL,
                severity TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'Open',
                created_at TEXT NOT NULL
            );
            """
        )
        if db.execute("SELECT COUNT(*) FROM login_events").fetchone()[0] == 0:
            seed_demo_data(db)


def seed_demo_data(db):
    now = datetime.now().replace(second=0, microsecond=0)
    samples = [
        ("maya.chen", "198.51.100.24", "San Francisco, US", "MacBook Pro · Chrome", 0, "Success", 8, []),
        ("jordan.lee", "203.0.113.42", "Austin, US", "Windows 11 · Edge", 0, "Success", 12, []),
        ("maya.chen", "198.51.100.24", "San Francisco, US", "MacBook Pro · Chrome", 0, "Success", 6, []),
        ("alex.rivera", "192.0.2.87", "Chicago, US", "iPhone 15 · Safari", 1, "Failed", 42, ["Failed login attempt"]),
        ("sam.patel", "203.0.113.108", "London, UK", "Linux · Firefox", 0, "Success", 28, ["Unfamiliar IP address"]),
        ("maya.chen", "192.0.2.201", "Singapore, SG", "Android · Chrome", 4, "Failed", 91, ["Multiple failed login attempts", "Unfamiliar IP address", "Unusual location", "New device"]),
        ("jordan.lee", "203.0.113.42", "Austin, US", "Windows 11 · Edge", 0, "Success", 9, []),
        ("taylor.kim", "192.0.2.155", "Toronto, CA", "MacBook Air · Safari", 2, "Failed", 58, ["Failed login attempts", "Unusual login hour"]),
        ("alex.rivera", "192.0.2.87", "Chicago, US", "iPhone 15 · Safari", 0, "Success", 10, []),
        ("sam.patel", "198.51.100.203", "Unknown · VPN", "Unknown · Linux", 5, "Failed", 96, ["Multiple failed login attempts", "Unfamiliar IP address", "Unusual location", "Unusual login hour", "New device"]),
        ("maya.chen", "198.51.100.24", "San Francisco, US", "MacBook Pro · Chrome", 0, "Success", 5, []),
        ("jordan.lee", "203.0.113.42", "Austin, US", "Windows 11 · Edge", 0, "Success", 7, []),
    ]
    for index, (username, ip, location, device, failed, status, score, reasons) in enumerate(samples):
        happened = now - timedelta(days=index % 7, hours=(index * 3) % 12, minutes=(index * 11) % 60)
        db.execute(
            """INSERT INTO login_events
               (username, ip_address, location, device, login_time, status, failed_attempts,
                risk_score, risk_level, reasons, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                username, ip, location, device, happened.isoformat(timespec="minutes"),
                status, failed, score, risk_level(score), json.dumps(reasons),
                happened.isoformat(timespec="seconds"),
            ),
        )
        if score >= 31:
            severity = risk_level(score)
            title = "Potential account takeover" if score >= 61 else "Suspicious login detected"
            db.execute(
                "INSERT INTO alerts (event_id, title, severity, created_at) VALUES (?, ?, ?, ?)",
                (db.execute("SELECT last_insert_rowid()").fetchone()[0], title, severity, happened.isoformat(timespec="seconds")),
            )


def event_dict(row):
    item = dict(row)
    item["reasons"] = json.loads(item["reasons"])
    return item


def all_events(db, limit=500):
    return [event_dict(row) for row in db.execute(
        "SELECT * FROM login_events ORDER BY login_time DESC, id DESC LIMIT ?", (limit,)
    ).fetchall()]


def calculate_risk(db, payload):
    username = str(payload.get("username", "")).strip()
    ip = str(payload.get("ip_address", "")).strip()
    location = str(payload.get("location", "")).strip()
    device = str(payload.get("device", "")).strip()
    if not all((username, ip, location, device)):
        raise ValueError("Username, IP address, location, and device are required.")

    try:
        login_time = datetime.fromisoformat(str(payload.get("login_time", "")).replace("Z", "+00:00"))
    except ValueError:
        raise ValueError("Enter a valid login date and time.")
    if login_time.tzinfo:
        login_time = login_time.astimezone().replace(tzinfo=None)
    try:
        failed_attempts = int(payload.get("failed_attempts", 0))
    except (TypeError, ValueError):
        raise ValueError("Failed attempt count must be a whole number.")
    if failed_attempts < 0 or failed_attempts > 100:
        raise ValueError("Failed attempt count must be between 0 and 100.")

    reasons = []
    score = 0
    if failed_attempts >= 3:
        score += 35
        reasons.append(f"Multiple failed login attempts ({failed_attempts})")
    elif failed_attempts:
        score += min(failed_attempts * 10, 20)
        reasons.append(f"{failed_attempts} failed login attempt(s)")

    history = db.execute(
        "SELECT ip_address, location, device, login_time FROM login_events WHERE username = ? ORDER BY login_time DESC LIMIT 50",
        (username,),
    ).fetchall()
    if history:
        known_ips = {row["ip_address"] for row in history}
        known_locations = {row["location"].casefold() for row in history}
        known_devices = {row["device"].casefold() for row in history}
        unfamiliar_ip = ip not in known_ips
        unusual_location = location.casefold() not in known_locations
        new_device = device.casefold() not in known_devices
        if unfamiliar_ip:
            score += 20
            reasons.append("Unfamiliar IP address")
        if unusual_location:
            score += 20
            reasons.append("Unusual location")
        if new_device:
            score += 15
            reasons.append("New or unfamiliar device")
        if sum((unfamiliar_ip, unusual_location, new_device)) >= 2:
            score += 10
            reasons.append("Sudden change from usual login behavior")
    else:
        score += 10
        reasons.append("No previous login history for this account")

    if login_time.hour < 6 or login_time.hour >= 23:
        score += 15
        reasons.append("Login at an unusual hour")

    recent = db.execute(
        "SELECT COUNT(*) FROM login_events WHERE username = ? AND created_at >= ?",
        (username, (datetime.now() - timedelta(minutes=10)).isoformat(timespec="seconds")),
    ).fetchone()[0]
    if recent >= 3:
        score += 15
        reasons.append("Multiple login attempts within a short time")

    score = min(score, 100)
    return {
        "username": username,
        "ip_address": ip,
        "location": location,
        "device": device,
        "login_time": login_time.isoformat(timespec="minutes"),
        "failed_attempts": failed_attempts,
        "score": score,
        "level": risk_level(score),
        "reasons": reasons,
        "recommended_actions": (
            ["Temporarily block sign-in", "Reset account password", "Review recent account activity", "Contact the account owner"]
            if score >= 61 else
            ["Verify this sign-in with the account owner", "Review the unfamiliar login details"]
            if score >= 31 else
            ["Continue monitoring for unusual activity"]
        ),
    }


@app.get("/")
def home():
    return render_template("index.html")


@app.get("/api/events")
def events_api():
    with get_db() as db:
        return jsonify(all_events(db))


@app.get("/api/alerts")
def alerts_api():
    with get_db() as db:
        rows = db.execute(
            """SELECT a.*, e.username, e.ip_address, e.location, e.device, e.failed_attempts,
                      e.risk_score, e.reasons, e.login_time
               FROM alerts a JOIN login_events e ON e.id = a.event_id
               ORDER BY a.created_at DESC LIMIT 100"""
        ).fetchall()
        alerts = [dict(row) for row in rows]
        for alert in alerts:
            alert["reasons"] = json.loads(alert["reasons"])
            alert["takeover"] = alert["risk_score"] >= 61
        return jsonify(alerts)


@app.get("/api/stats")
def stats_api():
    with get_db() as db:
        totals = db.execute(
            """SELECT COUNT(*) AS total,
                      SUM(CASE WHEN status = 'Success' THEN 1 ELSE 0 END) AS successful,
                      SUM(CASE WHEN status = 'Failed' THEN 1 ELSE 0 END) AS failed,
                      SUM(CASE WHEN risk_score >= 31 THEN 1 ELSE 0 END) AS suspicious,
                      SUM(CASE WHEN risk_score >= 61 THEN 1 ELSE 0 END) AS takeover
               FROM login_events"""
        ).fetchone()
        levels = db.execute(
            """SELECT risk_level, COUNT(*) AS count FROM login_events GROUP BY risk_level"""
        ).fetchall()
        return jsonify({
            "total": totals["total"] or 0,
            "successful": totals["successful"] or 0,
            "failed": totals["failed"] or 0,
            "suspicious": totals["suspicious"] or 0,
            "takeover": totals["takeover"] or 0,
            "risk_levels": {row["risk_level"]: row["count"] for row in levels},
        })


@app.post("/api/analyze")
def analyze_api():
    payload = request.get_json(silent=True) or {}
    with get_db() as db:
        try:
            result = calculate_risk(db, payload)
        except ValueError as error:
            return jsonify({"error": str(error)}), 400
        status = "Failed" if result["failed_attempts"] > 0 else "Success"
        created_at = datetime.now().isoformat(timespec="seconds")
        cursor = db.execute(
            """INSERT INTO login_events
               (username, ip_address, location, device, login_time, status, failed_attempts,
                risk_score, risk_level, reasons, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                result["username"], result["ip_address"], result["location"], result["device"],
                result["login_time"], status, result["failed_attempts"], result["score"],
                result["level"], json.dumps(result["reasons"]), created_at,
            ),
        )
        result["id"] = cursor.lastrowid
        if result["score"] >= 31:
            title = "Potential account takeover" if result["score"] >= 61 else "Suspicious login detected"
            db.execute(
                "INSERT INTO alerts (event_id, title, severity, created_at) VALUES (?, ?, ?, ?)",
                (result["id"], title, result["level"], created_at),
            )
        return jsonify(result), 201


@app.patch("/api/alerts/<int:alert_id>")
def update_alert(alert_id):
    payload = request.get_json(silent=True) or {}
    status = payload.get("status")
    if status not in {"Investigating", "Blocked (simulated)", "Password reset (simulated)", "Resolved"}:
        return jsonify({"error": "Choose a supported alert action."}), 400
    with get_db() as db:
        cursor = db.execute("UPDATE alerts SET status = ? WHERE id = ?", (status, alert_id))
        if cursor.rowcount == 0:
            return jsonify({"error": "Alert not found."}), 404
    return jsonify({"id": alert_id, "status": status})


@app.post("/api/reset")
def reset_demo():
    with get_db() as db:
        db.execute("DELETE FROM alerts")
        db.execute("DELETE FROM login_events")
        db.execute("DELETE FROM sqlite_sequence WHERE name IN ('alerts', 'login_events')")
        seed_demo_data(db)
    return jsonify({"message": "Demo data restored."})


@app.get("/api/export")
def export_csv():
    with get_db() as db:
        rows = db.execute(
            "SELECT username, ip_address, location, device, login_time, status, failed_attempts, risk_score, risk_level, reasons FROM login_events ORDER BY login_time DESC"
        ).fetchall()
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Username", "IP address", "Location", "Device", "Login time", "Status", "Failed attempts", "Risk score", "Risk level", "Detection reasons"])
    for row in rows:
        writer.writerow([*row[:9], "; ".join(json.loads(row["reasons"]))])
    return Response(
        output.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=secureguard-login-report.csv"},
    )


initialize_db()


if __name__ == "__main__":
    app.run(debug=os.environ.get("FLASK_DEBUG") == "1", host="127.0.0.1", port=int(os.environ.get("PORT", "5000")))

'use strict';

const{localDate} = require('./time');
const{predictDeadline} = require('./predict');

const sentDeadlineTiers = new Set();
const dedupeKey = (date, tier) => `${date}: ${tier}`;

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', 
    '<': '&lt;', 
    '>': '&gt;', 
    '"': '&quot;', 
    "'": '&#39;'}[c]));

function getSubscriberEmails(db){
    return db.prepare('SELECT email FROM subscribers').all().map((r) => r.email);
}

async function sendToAllSubscribers(db, mailer, { subject, html }, log){
    const emails = getSubscriberEmails(db);
    if (!emails.length) return {sent: false, reason: 'no-subscribers'};

    let delivered = 0;
    for (const email of emails){
        try{
            await mailer.sendMail({to: email, subject, html});
            delivered += 1;
        }
        catch (err){
            log.error(`[notify] failed to email ${email}: ${err.message}`);
        }
    }
    return {sent:delivered > 0, count: delivered, attempted: emails.length}
}

function renderFlagsEmail(date, flags){
    const items = flags.map((f) => `<li><strong>${escapeHtml(f.type)}</strong>: ${escapeHtml(f.detail)}</li>`).join('');

    return{
        subject: `Commit Doctor: ${flags.length} flag(s) for ${date}`,
        html: `<p>Commit Doctor noticed the following for <strong>${date}</strong>:</p><ul>${items}</ul>`,
    };
}

async function notifyFlags(db, config, mailer, date, flags, log = console){
    if (!flags.length) return {sent: false, reason: 'no-flags'}
    
    const result = await sendToAllSubscribers(db, mailer, renderFlagsEmail(date, flags), log);

    if (result.sent) log.info(`[notify] sent ${flags.length} flag(s) for ${date} to ${result.count} subscriber(s)`);
    return result;
}

const TIER_LABEL = {reminder: 'Reminder', urgent: 'Urgent', final: 'FINAL WARNING'}

function renderDeadlineEmail(p){
    const label = TIER_LABEL[p.urgency] || 'Notice';
    const pct = Math.round(p.pace_ratio * 100);
    const churnLine = p.churn_ratio != null ? `<p> Recent changes are ${Math.round(p.churn_ratio * 100)}% deletions/reworks (by ${p.churn_basis}).</p>`: '';

    return{
        subject: `Commit Doctor - ${label}: ${p.days_remaining} day(s) left (${p.status})`,
        html: `
        <p><strong>${label}:</strong> the deadline (${p.deadline_date}) is ${p.days_remaining} day(s)
        away. </p> <p> Recent commit pace is ${pct}% of the project's own average. Status: <strong>
        ${p.status}</strong>.</p> ${churnLine}
        `,
    };
}

async function checkDeadlineUrgency(db, config, mailer, log = console){
    const today = localDate(Date.now(), config.timezone);
    const prediction = predictDeadline(db, config, today);

    if (!prediction.urgency || prediction.urgency === 'none') return {sent: false, reason: 'no-escalation-needed'};

    const key = dedupeKey(today, prediction.urgency);
    if (sentDeadlineTiers.has(key)) return { sent: false, reason: 'already-sent-today' };

    const result = await sendToAllSubscribers(db, mailer, renderDeadlineEmail(prediction), log);
    if (result.sent){
        sentDeadlineTiers.add(key);
        log.info(`[notify] sent deadline "${prediction.urgency}" notice to ${result.count} subscriber(s)`);
    }
    return{...result, urgency: prediction.urgency};
}

module.exports = {notifyFlags, checkDeadlineUrgency};
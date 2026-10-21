const nodemailer = require('nodemailer');

function createMailer(config){
    const {host, port, user, pass, from} = config.smtp;
    if (!host) return null;

    const transport = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: user ? { user, pass } : undefined,
    });

    return {
        sendMail: ({ to, subject, html }) => transport.sendMail({ from, to, subject, html }),
    };
}

module.exports = {createMailer};
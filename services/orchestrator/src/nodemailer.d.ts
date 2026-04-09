declare module "nodemailer" {
  interface MailOptions {
    from: string;
    to: string;
    subject: string;
    text: string;
  }

  interface Transport {
    sendMail(options: MailOptions): Promise<void>;
  }

  const nodemailer: {
    createTransport(connectionUrl: string): Transport;
  };

  export default nodemailer;
}

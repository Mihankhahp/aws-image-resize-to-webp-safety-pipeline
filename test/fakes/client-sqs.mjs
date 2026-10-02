import { state, simulate } from './state.mjs';

export class SendMessageCommand {
  constructor(input) {
    this.input = input;
  }
}
export class SQSClient {
  constructor() {}
  async send(cmd) {
    const { QueueUrl, MessageBody } = cmd.input;
    return simulate('SQS.SendMessage', QueueUrl, () => {
      if (!state.sqs.has(QueueUrl)) state.sqs.set(QueueUrl, []);
      state.sqs.get(QueueUrl).push(MessageBody);
      return { MessageId: String(Math.random()) };
    });
  }
}

import { expect } from 'chai';
import { knownUsers, telegramPayload } from './telegram';

describe('telegram', () => {
    it('reads the users the telegram instance knows', () => {
        expect([...knownUsers('{"123":{"firstName":"A"},"456":{"firstName":"B"}}')]).to.deep.equal(['123', '456']);
        expect(knownUsers('').size).to.equal(0);
        expect(knownUsers('{').size).to.equal(0);
        expect(knownUsers('[1]').size).to.equal(0);
    });

    it('builds messages with an inline button', () => {
        expect(telegramPayload('hi')).to.deep.equal({ text: 'hi' });
        expect(telegramPayload('hi', { user: '' })).to.deep.equal({ text: 'hi' });
        expect(telegramPayload('hi', { chatId: 123 })).to.deep.equal({ text: 'hi', chatId: 123 });
        expect(telegramPayload('hi', { user: 'a' }, { label: 'L', data: 'd' })).to.deep.equal({
            text: 'hi',
            user: 'a',
            reply_markup: { inline_keyboard: [[{ text: 'L', callback_data: 'd' }]] },
        });
    });
});

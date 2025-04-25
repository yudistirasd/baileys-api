import type { proto, WAGenericMediaMessage, WAMessage } from "baileys";
import { downloadMediaMessage } from "baileys";
import { serializePrisma, delay as delayMs, logger, emitEvent } from "@/utils";
import type { RequestHandler } from "express";
import type { Message } from "@prisma/client";
import { prisma } from "@/config/database";
import WhatsappService from "@/whatsapp/service";
import { updatePresence } from "./misc";
import { WAPresence } from "@/types";

export const list: RequestHandler = async (req, res) => {
	try {
		const { sessionId } = req.params;
		const { cursor = undefined, limit = 25 } = req.query;
		const messages = (
			await prisma.message.findMany({
				cursor: cursor ? { pkId: Number(cursor) } : undefined,
				take: Number(limit),
				skip: cursor ? 1 : 0,
				where: { sessionId },
			})
		).map((m: Message) => serializePrisma(m));

		res.status(200).json({
			data: messages,
			cursor:
				messages.length !== 0 && messages.length === Number(limit)
					? messages[messages.length - 1].pkId
					: null,
		});
	} catch (e) {
		const message = "An error occured during message list";
		logger.error(e, message);
		res.status(500).json({ error: message });
	}
};

export const send: RequestHandler = async (req, res) => {
	try {
		const { jid, type = "number", message, options } = req.body;
		const sessionId = req.params.sessionId;
		const session = WhatsappService.getSession(sessionId)!;

		const validJid = await WhatsappService.validJid(session, jid, type);
		if (!validJid) return res.status(400).json({ error: "JID does not exists" });

		await updatePresence(session, WAPresence.Available, validJid);
		const result = await session.sendMessage(validJid, message, options);
		emitEvent("send.message", sessionId, { jid: validJid, result });
		res.status(200).json(result);
	} catch (e) {
		const message = "An error occured during message send";
		logger.error(e, message);

		let errorTrace = `Unknown error during during groups participants update`;

		if (e instanceof Error) errorTrace = `An error occured during groups participants update: ${e.message}`;

		emitEvent(
			"send.message",
			req.params.sessionId,
			undefined,
			"error",
			message + ": " + errorTrace,
		);
		res.status(500).json({ error: message });
	}
};

export const sendBulk: RequestHandler = async (req, res) => {
	const { sessionId } = req.params;
	const session = WhatsappService.getSession(sessionId)!;
	const results: { index: number; result: proto.WebMessageInfo | undefined }[] = [];
	const errors: { index: number; error: string }[] = [];

	for (const [
		index,
		{ jid, type = "number", delay = 1000, message, options },
	] of req.body.entries()) {
		try {
			const exists = await WhatsappService.jidExists(session, jid, type);
			if (!exists) {
				errors.push({ index, error: "JID does not exists" });
				continue;
			}

			if (index > 0) await delayMs(delay);

			await updatePresence(session, WAPresence.Available, jid);
			const result = await session.sendMessage(jid, message, options);
			results.push({ index, result });
			emitEvent("send.message", sessionId, { jid, result });
		} catch (e) {
			const message = "An error occured during message send";
			logger.error(e, message);
			errors.push({ index, error: message });

			let errorTrace = `Unknown error during during groups participants update`;

			if (e instanceof Error) errorTrace = `An error occured during groups participants update: ${e.message}`;

			emitEvent("send.message", sessionId, undefined, "error", message + ": " + errorTrace);
		}
	}

	res.status(req.body.length !== 0 && errors.length === req.body.length ? 500 : 200).json({
		results,
		errors,
	});
};

export const download: RequestHandler = async (req, res) => {
	try {
		const session = WhatsappService.getSession(req.params.sessionId)!;
		const message = req.body as WAMessage;
		const type = Object.keys(message.message!)[0] as keyof proto.IMessage;
		const content = message.message![type] as WAGenericMediaMessage;
		const buffer = await downloadMediaMessage(
			message,
			"buffer",
			{},
			{ logger, reuploadRequest: session.updateMediaMessage },
		);

		res.setHeader("Content-Type", content.mimetype!);
		res.write(buffer);
		res.end();
	} catch (e) {
		const message = "An error occured during message media download";
		logger.error(e, message);
		res.status(500).json({ error: message });
	}
};

// TODO: Added validation for message objects in the delete message and delete message only me functions.
export const deleteMessage: RequestHandler = async (req, res) => {
	try {
		const { sessionId } = req.params;
		/**
		 * @type {string} jid
		 * @type {string} type
		 * @type {object} message
		 *
		 * @example {
		 * 	"jid": "120363xxx8@g.us",
		 * 	"type": "group",
		 * 	"message": {
		 * 		"remoteJid": "120363xxx8@g.us",
		 * 		"fromMe": false,
		 * 		"id": "3EB0829036xxxxx"
		 * 	}
		 * }
		 * @returns {object} result
		 */
		const { jid, type = "number", message } = req.body;
		const session = WhatsappService.getSession(sessionId)!;

		const exists = await WhatsappService.jidExists(session, jid, type);
		if (!exists) return res.status(400).json({ error: "JID does not exists" });

		const result = await session.sendMessage(jid, { delete: message });

		res.status(200).json(result);
	} catch (e) {
		const message = "An error occured during message delete";
		logger.error(e, message);
		res.status(500).json({ error: message });
	}
};

export const deleteMessageForMe: RequestHandler = async (req, res) => {
	try {
		const { sessionId } = req.params;
		/**
		 * @type {string} jid
		 * @type {string} type
		 * @type {object} message
		 *
		 * @example {
		 * 	"jid": "120363xxx8@g.us",
		 * 	"type": "group",
		 * 	"message": {
		 * 		"id": "ATWYHDNNWU81732J",
		 * 		"fromMe": false,
		 * 		"timestamp": "1654823909"
		 * 	}
		 * }
		 * @returns {object} result
		 */
		const { jid, type = "number", message } = req.body;
		const session = WhatsappService.getSession(sessionId)!;

		const exists = await WhatsappService.jidExists(session, jid, type);
		if (!exists) return res.status(400).json({ error: "JID does not exists" });

		const result = await session.chatModify({ clear: true }, jid);

		res.status(200).json(result);
	} catch (e) {
		const message = "An error occured during message delete";
		logger.error(e, message);
		res.status(500).json({ error: message });
	}
};

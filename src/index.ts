import { BoardRunner, GraphDescriptor } from "@google-labs/breadboard";
import * as mermaidCli from "@mermaid-js/mermaid-cli";
import {
	Client,
	Events,
	GatewayIntentBits,
	Guild,
	GuildBasedChannel,
	Interaction,
	Message,
	MessagePayload,
	MessagePayloadOption,
	Partials,
	REST,
	Routes,
	SlashCommandBuilder,
	User,
} from "discord.js";
import "dotenv/config";
import express from 'express';
import fs from "fs";
import os from "os";
import path from "path";
import { is, validate } from "typia";

const app = express();
let botLoggedIn = false;
const port = process.env.PORT || 8080;

type Action = (interaction: any) => Promise<void> | void;

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
if (!DISCORD_CLIENT_ID) {
	throw new Error("Missing DISCORD_CLIENT_ID");
}
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
	throw new Error("Missing DISCORD_TOKEN");
}

const loadBoardCommand = new SlashCommandBuilder()
	.setName("load")
	.setDescription("Loads a board from a url")
	.addStringOption((option) =>
		option
			.setName("url")
			.setDescription("The url of the board")
			.setRequired(true)
	);

async function setCommand(
	client_id: string,
	token: string,
	command: Omit<SlashCommandBuilder, "addSubcommand" | "addSubcommandGroup">
) {
	const commandData = command.toJSON();
	const result = await new REST()
		.setToken(token)
		.put(Routes.applicationCommands(client_id), {
			body: [commandData],
		});
	console.log({ result });
	return result;
}

await setCommand(DISCORD_CLIENT_ID, DISCORD_TOKEN, loadBoardCommand);

const client = new Client({
	intents: [
		GatewayIntentBits.DirectMessages,
		GatewayIntentBits.GuildMembers,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.Guilds,
		GatewayIntentBits.MessageContent,
	],
	partials: [Partials.Channel, Partials.Message],
});

client.on(Events.ClientReady, (client) => {
	botLoggedIn = true;
});

app.get('/healthz', (req, res) => {
	if (botLoggedIn) {
		res.status(200).send('Bot is operational');
	} else {
		res.status(503).send('Bot is not logged in');
	}
});

app.listen(port, () => {
	console.log(`Server started on port ${port}`);
});

client.on(Events.ClientReady, (client) => {
	console.log("Ready");
	client.guilds.cache.forEach((guild: Guild) => {
		console.debug("----");
		guild.channels.cache.forEach((channel: GuildBasedChannel): void => {
			console.debug(guild.name, "-", channel.name);
		});
	});
});

client.on(Events.MessageCreate, async (message): Promise<void> => {
	console.log({ message });
});

function isValidURL(url: string): boolean {
	try {
		new URL(url);
		return true;
	} catch (error) {
		return false;
	}
}
function extractFileNameAndExtension(url: string): {
	name: string;
	extension: string;
} {
	// Extract the last part of the URL (after the last '/')
	const lastSegment = url.split("/").pop();
	if (!lastSegment) {
		return { name: "", extension: "" };
	}

	// Find the last '.' to separate the name and extension
	const lastDotIndex = lastSegment.lastIndexOf(".");

	// If there's no '.', return the whole segment as the name
	if (lastDotIndex === -1) {
		return { name: lastSegment, extension: "" };
	}

	// Extract the name and extension
	const name = lastSegment.substring(0, lastDotIndex);
	const extension = lastSegment.substring(lastDotIndex + 1);

	return { name, extension };
}

client.on(Events.InteractionCreate, async (interaction): Promise<void> => {
	console.log({ interaction });
	const debug = {
		isAnySelectMenu: interaction.isAnySelectMenu(),
		isAutocomplete: interaction.isAutocomplete(),
		isButton: interaction.isButton(),
		isChannelSelectMenu: interaction.isChannelSelectMenu(),
		isChatInputCommand: interaction.isChatInputCommand(),
		isCommand: interaction.isCommand(),
		isContextMenuCommand: interaction.isContextMenuCommand(),
		isMentionableSelectMenu: interaction.isMentionableSelectMenu(),
		isMessageComponent: interaction.isMessageComponent(),
		isMessageContextMenuCommand: interaction.isMessageContextMenuCommand(),
		isModalSubmit: interaction.isModalSubmit(),
		isRepliable: interaction.isRepliable(),
		isRoleSelectMenu: interaction.isRoleSelectMenu(),
		isStringSelectMenu: interaction.isStringSelectMenu(),
		isUserContextMenuCommand: interaction.isUserContextMenuCommand(),
		isUserSelectMenu: interaction.isUserSelectMenu(),
	};
	console.debug({ debug });

	if (interaction.isChatInputCommand()) {
		const command = interaction.commandName;
		const options = interaction.options;
		const user: User = interaction.user;
		const userId = user.id;

		if (command === "load") {
			const url = options.getString("url") || "";
			if (!isValidURL(url)) {
				const message = `Invalid URL: \`${url}\``;
				await respond(interaction, message);
			} else if (!isJsonUrl(url)) {
				const message = `That URL does not end with .json: \`${url}\``;
				await respond(interaction, message);
			} else {
				let json: Object;
				try {
					json = await (await fetch(url)).json();
				} catch (error: any) {
					const message = [
						`I couldn't load that ${url}`,
						toJsonCodeFence(error.message),
					].join("\n");
					await respond(interaction, message);
					return;
				}

				if (!isGBL(json)) {
					const message = `Uh oh, that doesn't look like a board:\n${url}`;
					await respond(interaction, message);
					return;
				}
				const { name, extension } = extractFileNameAndExtension(url);
				const boardMetaDataMarkdown = generateBoardMetadataMarkdown(url, json);

				const loading = await respond(interaction, `Loading ${url}`);
				let message: Message = await respondInChannel(
					interaction,
					[
						`<@${userId}>`,
						boardMetaDataMarkdown,
						"⌛️ `json`",
						"⌛️ `markdown`",
						"⌛️ `mermaid`",
					].join("\n")
				);
				await loading.delete();

				const tempFilename = `${name}.json`;
				const { jsonFile, tempDir } = mkTempFile("breadbot", tempFilename);
				fs.writeFileSync(jsonFile, JSON.stringify(json, bigIntHandler, "\t"));
				message = await editMessage(message, {
					content: [
						`<@${userId}>`,
						boardMetaDataMarkdown,
						"✅ `json` ",
						"⌛️ `markdown`",
						"⌛️ `mermaid`",
					].join("\n"),
					files: [jsonFile],
				});

				const runner = await BoardRunner.fromGraphDescriptor(json);
				const boardMermaid = runner.mermaid();
				const mmdFile = path.join(tempDir, `${name}.mmd`);
				fs.writeFileSync(mmdFile, boardMermaid);

				const markdown = [url, "```mermaid", boardMermaid, "```"].join("\n");
				const markdownFile = path.join(tempDir, `${name}.md`);
				fs.writeFileSync(markdownFile, markdown);
				message = await editMessage(message, {
					content: [
						`<@${userId}>`,
						boardMetaDataMarkdown,
						"✅ `json` ",
						"✅ `markdown`",
						"⌛️ `mermaid`",
					].join("\n"),
					files: [jsonFile, markdownFile],
				});

				type OutputExtension = "md" | "markdown" | "svg" | "png" | "pdf";
				type MermaidOutput = `${string}.${OutputExtension}`;

				const outputFormat: OutputExtension = "png";
				const imageFile: MermaidOutput = path.join(
					tempDir,
					`${name}.${outputFormat}`
				) as MermaidOutput;

				await mermaidCli.run(mmdFile, imageFile, {
					outputFormat,
					puppeteerConfig: {
						headless: "new",
					},
				});

				console.log({ tempFile: imageFile });

				message = await editMessage(message, {
					content: [`<@${userId}>`, boardMetaDataMarkdown].join("\n"),
					files: [jsonFile, markdownFile, imageFile],
				});
			}
		}
	} else {
		await sendDebug(interaction, { debug });
	}
});

client.login(DISCORD_TOKEN);

function mkTempFile(prefix: string, tempFilename: string) {
	const tempDir = mkTempDir(prefix);
	const jsonFile = path.join(tempDir, tempFilename);
	return { jsonFile, tempDir };
}

function mkTempDir(prefix: string) {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function editMessage(
	message: Message<boolean>,
	messageContent: MessagePayloadOption
) {
	const payload: MessagePayload = new MessagePayload(
		message.channel,
		messageContent
	);
	message = await message.edit(payload);
	return message;
}

function generateBoardMetadataMarkdown(url: string, graph: GraphDescriptor) {
	const { name, extension } = extractFileNameAndExtension(url);
	const filename = `${name}.${extension}`;

	const stringBuilder: string[] = [];

	stringBuilder.push(`# [${graph.title || filename}](${graph.url || url})`);

	if (graph.description) {
		stringBuilder.push(`> ${graph.description}`);
	}

	if (graph.$schema) {
		stringBuilder.push(`[$chema](${graph.$schema})`);
	}

	const nodeCount = graph.nodes.length;
	const edgeCount = graph.edges.length;
	const kitCount = graph.kits?.length || 0;
	const graphs: number = graph.graphs
		? Object.keys(graph.graphs).length + 1
		: 1;

	const stats = [
		"```",
		`nodes:  ${nodeCount}`,
		`edges:  ${edgeCount}`,
		`kits:   ${kitCount}`,
		`graphs: ${graphs}`,
		"```",
	].join("\n");
	stringBuilder.push(stats);

	return stringBuilder.join("\n");
}

async function sendDebug(interaction: Interaction, response?: Object) {
	const message = { interaction, ...response };
	const codeFence = toJsonCodeFence(message);
	console.debug({ message });
	await respond(interaction, codeFence);
}

async function respond(interaction: Interaction, message: string) {
	if (interaction.isRepliable()) {
		return await interaction.reply(message);
	} else {
		return await respondInChannel(interaction, message);
	}
}

async function respondInChannel(
	interaction: Interaction,
	message: string,
	options: Omit<MessagePayloadOption, "content"> = {}
): Promise<Message> {
	if (!interaction.channel) {
		throw new Error("No channel to respond in");
	}
	const payload = new MessagePayload(interaction.channel, {
		content: message,
		ephemeral: true,
		...options,
	});
	return await interaction.channel.send(payload);
}

function bigIntHandler(key: any, value: { toString: () => any }) {
	return typeof value === "bigint" ? value.toString() : value;
}

function truncateObject(
	obj: any,
	maxLength: number,
	preserveKeys: string[] = [],
	lessImportantKeys: string[] = [],
	currentDepth: number = 0
): Object {
	let jsonString = JSON.stringify(obj, bigIntHandler, "\t");

	if (jsonString.length <= maxLength) {
		return obj;
	}

	// Function to recursively truncate objects
	function truncateRecursively(
		currentObj: any,
		currentMaxLength: number,
		depth: number
	) {
		const keys = Object.keys(currentObj);
		for (const key of keys) {
			// Skip preserved keys or if length is within limit
			if (preserveKeys.includes(key) || jsonString.length <= currentMaxLength) {
				continue;
			}

			// Handle less important keys differently based on depth
			if (depth > 0 && lessImportantKeys.includes(key)) {
				delete currentObj[key];
				jsonString = JSON.stringify(obj, bigIntHandler, "\t");
				if (jsonString.length <= currentMaxLength) {
					break;
				}
				continue;
			}

			const value = currentObj[key];
			if (typeof value === "string") {
				// Truncate strings
				currentObj[key] = value.substring(
					0,
					value.length - (jsonString.length - currentMaxLength)
				);
			} else if (typeof value === "object" && value !== null) {
				// Recursively handle nested objects
				truncateRecursively(
					value,
					currentMaxLength -
						jsonString.length +
						JSON.stringify(value, bigIntHandler).length,
					depth + 1
				);
			} else {
				// For other types, consider removing or reducing precision
				delete currentObj[key];
			}

			jsonString = JSON.stringify(obj, bigIntHandler, "\t");
			if (jsonString.length <= currentMaxLength) {
				break;
			}
		}
	}

	// Start the truncation process
	truncateRecursively(obj, maxLength, currentDepth);

	return obj;
}

function toJsonCodeFence(obj: any) {
	return [
		"```json",
		JSON.stringify(
			truncateObject(
				obj,
				1000,
				["title", "description", "$schema", "configuration"],
				["description"]
			),
			bigIntHandler,
			"\t"
		),
		"```",
	].join("\n");
}

function isJsonUrl(url: string): boolean {
	return isValidURL(url) && url.endsWith(".json");
}

function isGBL(json: any): json is GraphDescriptor {
	const valid = is<GraphDescriptor>(json);
	if (!valid) {
		const validation = validate<GraphDescriptor>(json);
		console.debug({ validation });
	}
	return valid;
}

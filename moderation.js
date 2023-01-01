import {
    ActionRowBuilder,
    ActivityType,
    AttachmentBuilder,
    ButtonBuilder,
    ButtonStyle,
    Client,
    Events,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder
} from "discord.js"

import util from "node:util"

import app from "./app.js"
import bot from "./bot.js"

var client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages] })
var channel
var moderatorRoleId

function initialize(credentials) {
    moderatorRoleId = credentials.moderatorRoleId

    return new Promise((resolve) => {
        client.login(credentials.token)

        client.once(Events.ClientReady, async () => {
            await deployCommands(credentials.token)

            console.log(`Logged into Discord as "${client.user.tag}" (${client.user.id})`)
            channel = client.channels.cache.find(channel => channel.id == credentials.channelId)
    
            resolve()
        })

        client.on(Events.InteractionCreate, async (interaction) => {
            if (!interaction.isChatInputCommand() || !interactionFilter(interaction)) {
                return
            }

            switch (interaction.commandName) {
                case "review":
                    let plates = await startReviewProcessForUser(interaction)
                    app.addPlatesToQueue(plates)

                    break
                case "queue":
                    await interaction.deferReply({ ephemeral: true })

                    let queue = app.getQueue()
                    queue = queue.map(plate => `\`${plate.text}\``)

                    await interaction.editReply({
                        content: `There are **${queue.length}** plate(s) left to be posted, and they are: ${queue.join(", ")}.`,
                        ephemeral: true
                    })

                    break
            }
        })
    })
}

async function deployCommands(token) {
    let rest = new REST({ version: "10" }).setToken(token)
    let commands = [
        new SlashCommandBuilder().setName("review").setDescription("Review some plates").toJSON(),
        new SlashCommandBuilder().setName("queue").setDescription("Returns the plates in the queue").toJSON()
    ]

    await rest.put(
        Routes.applicationCommands(client.user.id),
        { body: commands }
    )
}

async function interactionFilter(interaction) {
    let member = channel.guild.members.cache.get(interaction.user.id)
    
    return !member.bot && member.roles.cache.has(moderatorRoleId)
}

function process() {
    return new Promise(async (resolve) => {
        let buttons = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setLabel("Let me review some plates")
                    .setStyle(ButtonStyle.Primary)
                    .setCustomId("review")
                    .setDisabled(false)
            )
        
        let message = await channel.send({
            components: [ buttons ],
            content: `<@&${moderatorRoleId}> The queue is empty and new plates need to be reviewed!`
        })

        let opportunist = null
        let collector = message.createMessageComponentCollector({ interactionFilter, time: 60 * 60 * 24 * 1000 })
        collector.on("collect", async (interaction) => {
            if (opportunist !== null) {
                return
            }

            opportunist = channel.guild.members.cache.get(interaction.user.id)
            await message.edit({
                components: [],
                content: `~~${message.content}~~ <@${opportunist.id}> took the opportunity.`
            })

            let plates = await startReviewProcessForUser(interaction)
            resolve(plates)
        })
    })
}

async function startReviewProcessForUser(interaction) {
    let approvedPlates = []
    let isReviewing = true
    let tag = interaction.user.tag

    console.log(`"${tag}" started reviewing plates.`)

    await interaction.deferReply({ ephemeral: true })

    while (isReviewing) {
        await new Promise(async (resolve) => {
            let plate = await bot.getPlate()
            let buttons = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setLabel("Approve")
                        .setStyle(ButtonStyle.Primary)
                        .setCustomId("approve")
                        .setDisabled(false)
                )
                .addComponents(
                    new ButtonBuilder()
                        .setLabel("Disapprove")
                        .setStyle(ButtonStyle.Danger)
                        .setCustomId("disapprove")
                        .setDisabled(false)
                )
                .addComponents(
                    new ButtonBuilder()
                        .setLabel("I'm finished reviewing plates")
                        .setStyle(ButtonStyle.Secondary)
                        .setCustomId("finished")
                        .setDisabled(approvedPlates.length == 0)
                )
            
            let examplePostText = util.format(bot.formats.post, plate.customerComment, plate.dmvComment, plate.verdict ? "ACCEPTED" : "DENIED")

            let message = await interaction.editReply({
                files: [ new AttachmentBuilder(plate.fileName) ],
                components: [ buttons ],
                content: `Click the appropriate button to approve or disapprove this plate (\`${plate.text}\`). Please refer to the pins for moderation guidelines. This message will time out in **5 minutes**.\n\`\`\`${examplePostText}\`\`\``,
                ephemeral: true
            })
    
            let filter = async (response) => {
                let validIds = ["approve", "disapprove", "finished"]
                return response.user.tag == tag && validIds.includes(response.customId)
            }
    
            let collector = message.createMessageComponentCollector({ filter, time: 60 * 5 * 1000 })
    
            collector.on("collect", async (response) => {
                await interaction.editReply({
                    "components": [],
                    "files": []
                })

                switch (response.customId) {
                    case "approve":
                        console.log(`"${tag}" approved plate "${plate.text}".`)
                        approvedPlates.push(plate)
                        await interaction.editReply(`**Approved \`${plate.text}\`.** Fetching next plate...`)

                        break
                    case "disapprove":
                        console.log(`"${tag}" disapproved plate "${plate.text}".`)
                        bot.removePlate(plate)
                        await interaction.editReply(`**Disapproved \`${plate.text}\`.** Fetching next plate...`)

                        break
                    case "finished":
                        console.log(`"${tag}" stopped reviewing plates.`)
                        isReviewing = false
                        await interaction.editReply(`Stopped reviewing plates. You approved **${approvedPlates.length} plate(s).** You may always enter the command \`/review\` at any time to restart the review process.`)

                        break
                }

                response.deferUpdate({ ephemeral: true })
                collector.stop()
                resolve()
            })

            collector.on("end", async (collected) => {
                if (!collected.size) {
                    await interaction.editReply({
                        components: [],
                        files: [],
                        content: `Stopped reviewing plates (timed out). You approved **${approvedPlates.length} plate(s).** You may always enter the command \`/review\` at any time to restart the review process.`
                    })

                    isReviewing = false

                    collector.stop()
                    resolve()
                }
            })
        })
    }

    return approvedPlates
}

async function notify(plate) {
    return await channel.send(`Posting plate \`${plate.text}\`...`)
}

async function updateNotification(notification, plate, urls, finished) {
    let body = `Posting plate \`${plate.text}\`...${finished ? " finished!" : ""}\n`

    for (let [service, url] of Object.entries(urls)) {
        body += `**${service}:** <${url}>\n`
    }

    await notification.edit(body)
}

async function notifyQueueAmount(queueAmount) {
    await channel.send(`There are **${queueAmount}** plate(s) left in the queue.`)

    if (queueAmount == 0) {
        app.addPlatesToQueue(await process())
    }
}

async function updateStatus(queueAmount) {
    client.user.setPresence({ activities: [{ name: `${queueAmount} plate(s) left to be posted` }] });
}

export default { initialize, process, notify, updateNotification, notifyQueueAmount, updateStatus }
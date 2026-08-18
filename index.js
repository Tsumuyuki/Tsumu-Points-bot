/**
 * ============================================================================
 *  雪平つむぎ様 リスナーポイント照会Discordボット（Phase 2）
 * ============================================================================
 *
 * 【このボットがやること】
 *  Discordサーバーで「/ポイント 名前:○○」と打つと、Googleスプレッドシートの
 *  台帳（Apps Scriptのウェブアプリ経由）を検索して、ポイント残高を返信します。
 *
 * 【必要な環境変数（Railwayの「Variables」タブで設定します）】
 *  DISCORD_TOKEN  … Discord Developer Portalで発行したボットのトークン
 *  CLIENT_ID      … Discord Developer Portalの「Application ID」
 *  GUILD_ID       … コマンドを反映させたいDiscordサーバーのID（省略可）
 *  SHEET_API_URL  … Apps Scriptを「ウェブアプリ」としてデプロイしたときのURL
 *                    （/exec で終わるもの）
 *
 * 詳しいセットアップ手順は同封の「Discordボット_セットアップ手順書.md」を
 * ご覧ください。
 */

const http = require('http');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
} = require('discord.js');

// ----------------------------------------------------------------------------
// Renderの無料プランは「Webサービス」として動かす場合、外部からのアクセスが
// 一定時間ないとスリープしてしまいます。それを防ぐため、ごく簡単なHTTPサーバーを
// 立てておき、UptimeRobotなどの外部サービスから定期的にアクセスしてもらう
// ことで、ボットを起動させ続けます（詳しくはセットアップ手順書をご覧ください）。
// ----------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('雪平つむぎ リスナーポイント照会ボット、稼働中です。');
  })
  .listen(PORT, () => {
    console.log(`ヘルスチェック用サーバーがポート${PORT}で待機中です`);
  });

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID; // 未設定でも動きます（反映まで時間がかかるだけです）
const SHEET_API_URL = process.env.SHEET_API_URL;

// 起動時に必須の環境変数が揃っているか確認する（揃っていないと分かりにくいエラーになるため）
function checkEnv() {
  const missing = [];
  if (!TOKEN) missing.push('DISCORD_TOKEN');
  if (!CLIENT_ID) missing.push('CLIENT_ID');
  if (!SHEET_API_URL) missing.push('SHEET_API_URL');
  if (missing.length > 0) {
    console.error('必要な環境変数が設定されていません: ' + missing.join(', '));
    console.error('Railwayの「Variables」タブで設定してから、再デプロイしてください。');
    process.exit(1);
  }
}
checkEnv();

const commands = [
  new SlashCommandBuilder()
    .setName('ポイント')
    .setDescription('リスナーポイントの残高を確認します')
    .addStringOption((option) =>
      option
        .setName('名前')
        .setDescription('配信でコメントするときの表示名')
        .setRequired(true)
    ),
].map((cmd) => cmd.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
        body: commands,
      });
      console.log('スラッシュコマンドを登録しました（サーバー限定・すぐ反映されます）');
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log(
        'スラッシュコマンドを登録しました（全サーバー向け・反映まで最大1時間ほどかかることがあります）'
      );
    }
  } catch (err) {
    console.error('スラッシュコマンドの登録に失敗しました:', err);
  }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  console.log(`ログイン完了: ${client.user.tag} として動作中です`);
  await registerCommands();
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'ポイント') return;

  const name = interaction.options.getString('名前');
  await interaction.deferReply();

  try {
    const url = `${SHEET_API_URL}?name=${encodeURIComponent(name)}`;
    const res = await fetch(url);

    if (!res.ok) {
      console.error('スプレッドシートAPIへのアクセスに失敗しました。ステータス: ' + res.status);
      await interaction.editReply(
        'ポイントの取得中にエラーが発生しました（スプレッドシート側との通信エラー）。時間をおいてもう一度お試しください。'
      );
      return;
    }

    const data = await res.json();

    if (data.status === 'error') {
      console.error('スプレッドシートAPIがエラーを返しました:', data.message);
      await interaction.editReply('ポイントの取得中にエラーが発生しました。しばらくしてから再度お試しください。');
      return;
    }

    if (data.status === 'not_found') {
      await interaction.editReply(
        `「${name}」という表示名は台帳に見つかりませんでした。配信でコメントするときの名前と完全に一致しているか確認してください。`
      );
      return;
    }

    if (data.status === 'ambiguous') {
      await interaction.editReply(
        `「${name}」に近い名前が複数見つかりました。もう少し詳しく（フルネームで）入力してください。\n候補: ${data.candidates.join(' / ')}`
      );
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(`${data.name} さんのポイント`)
      .setColor(0xffcc00)
      .addFields(
        { name: '来場pt（YouTube）', value: String(data.attend), inline: true },
        { name: 'ギフト・メンバーpt（YouTube）', value: String(data.gift), inline: true },
        { name: 'TikTok分pt', value: String(data.tiktok), inline: true },
        { name: '使用済みpt', value: String(data.used), inline: true },
        { name: '残高', value: `**${data.balance} pt**`, inline: false }
      );

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error('ポイント取得中に予期しないエラーが発生しました:', err);
    await interaction.editReply('ポイントの取得中にエラーが発生しました。時間をおいてもう一度お試しください。');
  }
});

client.login(TOKEN);

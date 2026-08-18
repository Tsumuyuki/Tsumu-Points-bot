/**
 * ============================================================================
 *  雪平つむぎ様 リスナーポイント照会・管理Discordボット（Phase 2 + Phase 3）
 * ============================================================================
 *
 * 【このボットがやること】
 *  ・「/ポイント 名前:○○」… 誰でも使えます。ポイント残高を確認します。
 *  ・「/ポイント追加 名前:○○ pt数:10」… 管理者専用。台帳に手動でポイントを
 *    加算します（TikTok分の投げ銭などを記録するときに使います）。
 *  ・「/ポイント消費 名前:○○ pt数:10」… 管理者専用。特典と引き換えに
 *    ポイントを消費（残高を減らす）します。残高が足りない場合は失敗します。
 *  いずれもGoogleスプレッドシートの台帳（Apps Scriptのウェブアプリ経由）と
 *  やりとりします。
 *
 * 【必要な環境変数（Renderの「Environment」タブで設定します）】
 *  DISCORD_TOKEN  … Discord Developer Portalで発行したボットのトークン
 *  CLIENT_ID      … Discord Developer Portalの「Application ID」
 *  GUILD_ID       … コマンドを反映させたいDiscordサーバーのID（省略可）
 *  SHEET_API_URL  … Apps Scriptを「ウェブアプリ」としてデプロイしたときのURL
 *                    （/exec で終わるもの）
 *  API_SECRET     … Apps Script側の同名の定数と完全に一致させる合言葉
 *                    （/ポイント追加・/ポイント消費の書き込みを認証するためのものです）
 *
 * 【管理者コマンドを使える人】
 *  「/ポイント追加」「/ポイント消費」は、Discordサーバーで「サーバー管理」権限を
 *  持つ人（つむぎさんや、権限を渡したモデレーターなど）にのみ表示されます。
 *  一般のリスナーさんの画面には出てきません。
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
  PermissionFlagsBits,
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
const API_SECRET = process.env.API_SECRET;

// 起動時に必須の環境変数が揃っているか確認する（揃っていないと分かりにくいエラーになるため）
function checkEnv() {
  const missing = [];
  if (!TOKEN) missing.push('DISCORD_TOKEN');
  if (!CLIENT_ID) missing.push('CLIENT_ID');
  if (!SHEET_API_URL) missing.push('SHEET_API_URL');
  if (!API_SECRET) missing.push('API_SECRET');
  if (missing.length > 0) {
    console.error('必要な環境変数が設定されていません: ' + missing.join(', '));
    console.error('Renderの「Environment」タブで設定してから、再デプロイしてください。');
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
  new SlashCommandBuilder()
    .setName('ポイント追加')
    .setDescription('【管理者用】台帳にポイントを手動で加算します（TikTok分の記録などに使います）')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((option) =>
      option.setName('名前').setDescription('対象の表示名').setRequired(true)
    )
    .addIntegerOption((option) =>
      option.setName('pt数').setDescription('加算するポイント数').setRequired(true).setMinValue(1)
    )
    .addStringOption((option) =>
      option.setName('メモ').setDescription('記録用のメモ（任意）').setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('ポイント消費')
    .setDescription('【管理者用】特典と引き換えにポイントを消費します（残高が足りないと失敗します）')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((option) =>
      option.setName('名前').setDescription('対象の表示名').setRequired(true)
    )
    .addIntegerOption((option) =>
      option.setName('pt数').setDescription('消費するポイント数').setRequired(true).setMinValue(1)
    )
    .addStringOption((option) =>
      option.setName('メモ').setDescription('記録用のメモ（任意、例：キラキラ通話10）').setRequired(false)
    ),
].map((cmd) => cmd.toJSON());

// 台帳への書き込み（追加・消費）を、Apps Scriptのウェブアプリに依頼する共通処理
async function postToSheet(action, name, points, note) {
  const res = await fetch(SHEET_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // Apps Script側の都合でtext/plainにしています
    body: JSON.stringify({ secret: API_SECRET, action, name, points, note }),
  });

  if (!res.ok) {
    throw new Error('スプレッドシートAPIへのアクセスに失敗しました。ステータス: ' + res.status);
  }
  return res.json();
}

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

  if (interaction.commandName === 'ポイント追加' || interaction.commandName === 'ポイント消費') {
    const action = interaction.commandName === 'ポイント追加' ? 'add' : 'use';
    const name = interaction.options.getString('名前');
    const points = interaction.options.getInteger('pt数');
    const note = interaction.options.getString('メモ') || '';

    await interaction.deferReply();

    try {
      const data = await postToSheet(action, name, points, note);

      if (data.status === 'error') {
        console.error('スプレッドシートAPIがエラーを返しました:', data.message);
        await interaction.editReply(`エラーが発生しました: ${data.message || '不明なエラー'}`);
        return;
      }

      if (data.status === 'insufficient') {
        await interaction.editReply(
          `「${data.name}」さんの残高（${data.balance}pt）が足りないため、${points}ptの消費はできませんでした。`
        );
        return;
      }

      const actionLabel = action === 'add' ? '加算' : '消費';
      await interaction.editReply(
        `「${data.name}」さんに ${points}pt を${actionLabel}しました。${note ? `（メモ: ${note}）` : ''}\n現在の残高: **${data.balance}pt**`
      );
    } catch (err) {
      console.error(`ポイント${action === 'add' ? '追加' : '消費'}中に予期しないエラーが発生しました:`, err);
      await interaction.editReply('処理中にエラーが発生しました。時間をおいてもう一度お試しください。');
    }
    return;
  }

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
client.login(TOKEN);

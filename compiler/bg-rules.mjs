/**
 * bg-rules.mjs —— 「剧幕/文本 → 背景图」的唯一实现
 *
 * ★ 为什么单独一个文件：原先 `BG_RULES` 写在 `build-demo.mjs` 里。
 *   现在 `segments.mjs`（配乐分段）也要给每段标"这一段在哪个场景"，
 *   如果各自复制一份规则，两边迟早漂移（纪律：**同一份规则只能有一处实现**）。
 *   ⇒ 抽到这里，两边都 import。
 *
 * ★★ 词表必须与 `demo-assets.mjs` 的 `BGS` **同名对齐**：
 *   那边**生成**哪些占位图，这边的规则就只能指向那些名字。
 *   对不上的后果不是报错，是**画面静默空白**（WebGAL 找不到图就不显示背景）。
 *   ⇒ 改完跑 `node verify-repo.mjs`，它会交叉核对这两份名单。
 *
 * ★ 把下面每条规则的场景词换成你自己作品的词表即可。
 *   **顺序有意义**：越具体的越靠前（「庄园残骸」必须排在「庄园」前面，
 *   否则残骸会被判成完好的庄园）。
 */

export const BG_RULES = [
  [/残骸|废墟|坍塌|断壁|瓦砾|硝烟|爆炸现场/, 'bg_ruin.png'],
  [/会场|舞台中央|聚光灯|观众席|荧光棒|穹顶|演唱|巡演|演出/, 'bg_hall.png'],
  [/消毒水|病房|ICU|监护仪|输液|病床|白大褂|手术室/, 'bg_hospital.png'],
  [/安全屋|安全层|全息沙盘|服务器架/, 'bg_safehouse.png'],
  [/地下二层|地下通道|地下管网|地下设施|静养区/, 'bg_underground.png'],
  [/水产|加工厂|冷库|废弃仓库/, 'bg_warehouse.png'],
  [/胶囊旅馆|租赁屋|老旧公寓|榻榻米上|窗帘紧闭/, 'bg_room.png'],
  [/客厅的沙发|窗棂|住宅|室内.*沙发/, 'bg_livingroom.png'],
  [/居高临下.*公寓|游戏室|棋盘|顶层公寓/, 'bg_apartment.png'],
  [/货轮|远洋|货舱|船舱|冷链物流/, 'bg_cabin.png'],
  [/直升机|机舱|舷窗/, 'bg_helicopter.png'],
  [/图书馆|档案库|书架/, 'bg_library.png'],
  [/庄园|主宅|庭园|和室|茶道|纸灯笼|地堡/, 'bg_manor.png'],
  [/Live House|Livehouse|现场演出/, 'bg_stage.png'],
  [/霓虹|十字路口|街头|街道|摩天楼|天际线|都市的夜|雨巷|巷口/, 'bg_city.png'],
  [/走廊|楼道|教室|学校|公寓楼|电梯前室/, 'bg_corridor.png'],
];

/** 兜底：所有规则都没命中时用它。★ 必须也是 demo-assets 会生成的名字。 */
export const DEFAULT_BG = 'bg_corridor.png';

/** 用「幕名 + 该幕前若干段正文」一起匹配（幕名权重更高，故排前面） */
export function bgForScene(sceneTitle, sampleText) {
  const s = `${sceneTitle || ''} ${sampleText || ''}`;
  for (const [re, bg] of BG_RULES) if (re.test(s)) return bg;
  return DEFAULT_BG;
}

/** 给一段正文猜背景（配乐分段用：段内文本自己匹配，没有"幕名"可借） */
export function bgForText(text) {
  const s = String(text || '');
  for (const [re, bg] of BG_RULES) if (re.test(s)) return bg;
  return DEFAULT_BG;
}

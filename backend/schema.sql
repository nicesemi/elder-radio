-- =============================================
-- 老年AI收音机 - Supabase 数据库迁移脚本
-- 在 Supabase SQL Editor 中执行
-- =============================================

-- 表1: 语音包
CREATE TABLE IF NOT EXISTS voice_packs (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    era TEXT NOT NULL,
    voice_id TEXT NOT NULL,
    description TEXT,
    preview_url TEXT,
    price NUMERIC(10,2) DEFAULT 0,
    is_preset BOOLEAN DEFAULT false,
    is_purchased BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 表2: 资源内容
CREATE TABLE IF NOT EXISTS resource_articles (
    id BIGSERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT,
    era TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'news',
    summary TEXT,
    audio_url TEXT,
    image_url TEXT,
    status TEXT DEFAULT 'draft',
    reviewed_by TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_articles_era ON resource_articles(era);
CREATE INDEX IF NOT EXISTS idx_articles_category ON resource_articles(category);
CREATE INDEX IF NOT EXISTS idx_articles_status ON resource_articles(status);

-- 表3: 对话记录
CREATE TABLE IF NOT EXISTS customer_conversations (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT DEFAULT 'anonymous',
    session_id TEXT NOT NULL,
    channel TEXT DEFAULT 'chat',
    era TEXT,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversations_session ON customer_conversations(session_id);
CREATE INDEX IF NOT EXISTS idx_conversations_created ON customer_conversations(created_at DESC);

-- 表4: 客户需求/商机
CREATE TABLE IF NOT EXISTS customer_leads (
    id BIGSERIAL PRIMARY KEY,
    conversation_id BIGINT REFERENCES customer_conversations(id) ON DELETE SET NULL,
    user_id TEXT DEFAULT 'anonymous',
    lead_type TEXT NOT NULL DEFAULT '咨询',
    priority TEXT NOT NULL DEFAULT '中',
    description TEXT NOT NULL,
    status TEXT DEFAULT '新建',
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_leads_status ON customer_leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_priority ON customer_leads(priority);

-- 预置语音包种子数据
INSERT INTO voice_packs (name, era, voice_id, description, preview_url, price, is_preset, is_purchased) VALUES
('延安广播', '1950s', 'yunxi-1950', '字正腔圆、铿锵有力的延安广播风格', NULL, 0, true, true),
('建设时期播报', '1960s', 'yunjian-1960', '热情饱满、斗志昂扬的建设时期风格', NULL, 0, true, true),
('样板戏广播', '1970s', 'yunxi-1970', '庄重严肃的七十年代播音风格', NULL, 0, true, true),
('改革开放播报', '1980s', 'yunyang-1980', '朝气蓬勃的改革开放初期风格', NULL, 0, true, true),
('九十年代电台', '1990s', 'yunyang-1990', '轻松自然的九十年代电台风格', NULL, 0, true, true),
('新世纪广播', '2000s', 'xiaoxiao-2000', '时尚活泼的千禧年广播风格', NULL, 0, true, true),
('现代播报', '2010s', 'xiaoyi-2010', '专业干练的现代新闻广播风格', NULL, 0, true, true),
('AI时代播报', '2020s', 'yunxi-2020', '清晰自然的当代智能广播风格', NULL, 0, true, true),
('邓丽君甜嗓', '1980s', 'custom-denglijun', '模仿邓丽君甜美的经典唱腔', 'https://example.com/preview/denglijun.mp3', 29.90, false, false),
('单田芳评书风', '1970s', 'custom-shantianfang', '评书大师单田芳的经典嗓音', 'https://example.com/preview/shantianfang.mp3', 39.90, false, false),
('赵忠祥解说', '1990s', 'custom-zhaozhongxiang', '动物世界赵忠祥的经典解说音色', 'https://example.com/preview/zhaozhongxiang.mp3', 29.90, false, false);

-- 预置资源内容种子数据
INSERT INTO resource_articles (title, content, era, category, summary, status) VALUES
('人民日报创刊号回顾', '1948年6月15日，人民日报在河北平山县西柏坡创刊。作为中国共产党中央委员会机关报，人民日报见证并记录了新中国的诞生与发展历程。', '1950s', 'news', '回顾人民日报创刊的历史背景与意义', 'published'),
('第一颗原子弹爆炸成功', '1964年10月16日，中国第一颗原子弹在新疆罗布泊爆炸成功。这标志着中国成为世界上第五个拥有核武器的国家。', '1960s', 'news', '中国第一颗原子弹爆炸的历史时刻', 'published'),
('改革开放元年', '1978年12月，党的十一届三中全会召开，开启了改革开放的伟大征程。从此中国经济走上了快速发展的道路。', '1970s', 'news', '十一届三中全会开启改革开放新篇章', 'published'),
('东方红一号卫星', '1970年4月24日，中国第一颗人造地球卫星"东方红一号"发射成功，标志着中国进入了太空时代。', '1970s', 'technology', '中国航天事业的里程碑', 'published'),
('中国女排首次夺冠', '1981年11月16日，中国女排在第三届世界杯女子排球赛中以3:2战胜日本队，首次夺得世界冠军。', '1980s', 'sports', '中国女排五连冠的开始', 'published'),
('小平南巡讲话', '1992年春，邓小平视察南方并发表重要讲话，强调发展才是硬道理，推动了中国市场经济的深化发展。', '1990s', 'news', '南巡讲话推动改革开放再出发', 'published'),
('香港回归祖国', '1997年7月1日，中华人民共和国政府对香港恢复行使主权，结束了香港长达156年的殖民统治。', '1990s', 'news', '香港回归祖国的历史性时刻', 'published'),
('北京奥运会成功举办', '2008年8月8日，第29届夏季奥林匹克运动会在北京开幕。中国以51枚金牌首次位列金牌榜第一。', '2000s', 'sports', '百年奥运梦想的实现', 'published'),
('中国加入世贸组织', '2001年12月11日，中国正式加入世界贸易组织（WTO），标志着中国全面融入全球经济体系。', '2000s', 'finance', '中国经济融入全球化的重要里程碑', 'published'),
('神州五号载人航天', '2003年10月15日，杨利伟乘坐神舟五号飞船进入太空，中国成为第三个独立掌握载人航天技术的国家。', '2000s', 'technology', '中国首次载人航天飞行', 'published');

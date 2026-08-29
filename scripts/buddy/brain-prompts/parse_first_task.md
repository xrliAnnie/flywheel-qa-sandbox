# 任务:把用户的大白话解析成结构化意图(parse_first_task)

用户刚被问「你最想让这个小团队先帮你搞定哪件事?」,下面 USER_INPUT 是 ta 的原话。

把它解析成一个 JSON 对象,**只输出这一个 JSON 对象,不要任何其它文字**:

{
  "intent": "<一句话概括 ta 想搞定的事,用 ta 自己的话>",
  "team_name": "<给这个小组起个贴合的中文名,2-6 个字,如「订单盯梢」>",
  "roles": ["<Captain 负责什么,一句话>", "<Crew 负责什么,一句话>"],
  "scope": "<第一步只做什么(收窄到一件可交付的事)>",
  "systems_needed": ["<需要接的业务系统,小写英文 id,只从这个集合里选: shopify, veeqo, ordoro, email>"],
  "confident": <true|false — 如果 USER_INPUT 太空泛(比如「帮我赚钱」)无法落到一件具体的事,置 false>
}

规则:
- systems_needed 只放这件事**真正需要**的最少集合;推断不出就给空数组。
- USER_INPUT 空泛时:confident=false,其它字段给出你最合理的猜测。
- 严格只输出 JSON。

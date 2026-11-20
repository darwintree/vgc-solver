import json,sys,collections
p=json.load(open(sys.argv[1])); nodes={n['id']:n for n in p['nodes']}; parents={child:n['id'] for n in p['nodes'] for child in n.get('children',[])}
selftime=collections.Counter(); inclusive=collections.Counter(); categories=collections.Counter()
for sample,dt in zip(p['samples'],p['timeDeltas']):
    node=nodes[sample]; stack=[]; cur=sample
    while cur in nodes:
        stack.append(nodes[cur]['callFrame']); cur=parents.get(cur)
    names={f['functionName'] for f in stack}; urls={f['url'] for f in stack}
    f=node['callFrame']; selftime[(f['functionName'],f['url'],f['lineNumber']+1)]+=dt
    for q in stack: inclusive[(q['functionName'],q['url'],q['lineNumber']+1)]+=dt
    if f['functionName']=='(garbage collector)': cat='GC'
    elif names & {'auditNativeRules','battleCallbacksAreNative','nativeDescriptorsAreIntact','createEventPlan','buildDefinitions','stockRuleProfile','auditPPBattle'}: cat='audit/prepare'
    elif names & {'restoreBattle','deserializeBattle','fromJSON'}: cat='restore/deserialize'
    elif names & {'snapshotBattle','serializeBattle','normalizeJSON'}: cat='snapshot/serialize'
    elif names & {'privateSnapshotKey','privateNodeKey','stateKey','makeCacheKey','ppBaseKey','stableStringify','canonicalizeSnapshot','effectOrderContext'}: cat='state/key'
    elif names & {'runEvent','singleEvent','findEventHandlers','findPokemonEventHandlers','hasPossibleEvent','eachEvent','noDamageObserver','canProbeTail'}: cat='event work'
    elif names & {'makeChoices','runTurn','runAction','runMove','tryMoveHit','useMove','useMoveInner'}: cat='other native simulation'
    elif any('/dist/src/' in u for u in urls): cat='other solver/transition'
    else: cat='startup/runtime'
    categories[cat]+=dt
T=sum(categories.values())
print('Total sample milliseconds',T/1000)
print('Categories',[(c,round(v/1000,1),round(v/T*100,1))for c,v in categories.most_common()])
for title,counts in [('SELF',selftime),('INCLUSIVE',inclusive)]:
    print(title)
    for (name,url,line),dt in counts.most_common(35): print(round(dt/1000,1),name,url.split('/')[-1],line)

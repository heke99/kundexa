const fs=require('node:fs'),ts=require('typescript'),assert=require('node:assert/strict'),React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
function load(file,mocks={}){const exports={};new Function('exports','require',ts.transpileModule(fs.readFileSync(file,'utf8'),{fileName:file,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText)(exports,id=>id in mocks?mocks[id]:['react','react/jsx-runtime','zod'].includes(id)?require(id):{});return exports;}
const context=load('src/lib/contracts/template-context.ts');
const fields=load('src/lib/contracts/pdf-field-template.ts',{'./template-context':context});
const defs=[{id:'anlaggning_id',label:'Anläggnings-ID',type:'text',required:true,customerKey:'anlaggning_id'},{id:'startdatum',label:'Startdatum',type:'date',required:false},{id:'antal',label:'Antal',type:'number',required:false}];
const config={custom_fields:defs};
const frozen=fields.freezeContractCustomFields(config,{antal:0},{anlaggning_id:'001234567890123456'});
assert.equal(frozen.values.anlaggning_id,'001234567890123456');assert.equal(frozen.values.antal,0);
assert.throws(()=>fields.freezeContractCustomFields(config,{}),/required_value/);
assert.throws(()=>fields.freezeContractCustomFields(config,{anlaggning_id:'  '}),/required_value/);
assert.throws(()=>fields.freezeContractCustomFields(config,{anlaggning_id:'123',unexpected:'x'}),/unknown_custom_value/);
for(const startdatum of ['2026-02-31','0000-01-01','bad'])assert.throws(()=>fields.freezeContractCustomFields(config,{anlaggning_id:'123',startdatum}),/invalid_date/);
assert.equal(fields.freezeContractCustomFields(config,{anlaggning_id:'override'},{anlaggning_id:'default'}).values.anlaggning_id,'override');
assert.throws(()=>fields.parseContractCustomFields([...defs,defs[0]]),/duplicate/);
assert.equal(context.validateTemplateVariables(['custom.anlaggning_id'],defs.map(d=>d.id)).length,0);
assert.equal(context.validateTemplateVariables(['custom.unknown'],defs.map(d=>d.id)).length,1);
const domain=load('src/lib/domain/template.ts');assert.equal(domain.renderStrictTemplate('Anläggning {{custom.anlaggning_id}}',{custom:frozen.values}),'Anläggning 001234567890123456');
assert.equal(fields.freezePdfTemplate(config,{custom:frozen.values},'tenant',frozen.values),null,'Text templates support declared fields without a PDF');
const pdf={schemaVersion:1,storagePath:`tenant/templates/source/${'a'.repeat(64)}.pdf`,sha256:'a'.repeat(64),pageSizes:[{width:600,height:800}],fields:[{id:'meter',label:'Anläggning',providerName:'meter',type:'text',source:'custom.anlaggning_id',required:true,fontSize:10,placements:[{page:0,x:.1,y:.1,width:.5,height:.05}]}]};
const pdfConfig={custom_fields:[defs[0]],pdf_template:pdf};
assert.equal(fields.freezePdfTemplate(pdfConfig,{},'tenant',{anlaggning_id:'001234'}).values.meter,'001234');
assert.throws(()=>fields.validatePdfTemplate({...pdf,fields:[{...pdf.fields[0],source:'customer.display_name'}]},'tenant',[defs[0]]),/custom_field_not_placed/);
const select=load('src/components/contract-product-select.tsx',{'@/lib/contracts/pdf-field-template':fields}).ContractProductSelect;
const html=renderToStaticMarkup(React.createElement(select,{products:[{id:'energy',label:'El',disabled:false,customFields:defs},{id:'other',label:'Other',disabled:false,customFields:[{id:'other_field',label:'Other',type:'text',required:true}]}],defaultValue:'energy',customerValues:{anlaggning_id:'001234'}}));
assert(html.includes('name="pdf_custom_anlaggning_id"'));assert(html.includes('value="001234"'));assert(!html.includes('name="pdf_custom_other_field"'));
const old=frozen.values.anlaggning_id;const updated=fields.freezeContractCustomFields(config,{anlaggning_id:'new'});assert.equal(frozen.values.anlaggning_id,old);assert.equal(updated.values.anlaggning_id,'new');
console.log('PASS: declared fields work without PDF, customer defaults preserve leading zero, explicit override, required/type/date/unknown validation, known placeholders, placed PDF values and selected-product form isolation.');

assert.equal(fields.customerFieldPrefill(defs[0],{anlaggning_id:123}).invalid,true,'Text IDs must not silently coerce a numeric customer value');
const directSelect=load('src/components/contract-product-select.tsx',{'@/lib/contracts/pdf-field-template':fields,react:{useState:value=>[value,()=>{}]}}).ContractProductSelect;
const scopedProps={products:[{id:'product',label:'Product',disabled:false,templateVersionId:'v1',customFields:defs}],defaultValue:'product',customerValues:{}};
const scope=props=>directSelect(props).props.children[1].key;
assert.notEqual(scope({...scopedProps,customerId:'a'}),scope({...scopedProps,customerId:'b'}));
assert.notEqual(scope({...scopedProps,customerId:'a'}),scope({...scopedProps,customerId:'a',products:[{...scopedProps.products[0],templateVersionId:'v2'}]}));
console.log('PASS: field controls remount across customer/template identity and invalid numeric customer IDs are not silently coerced into text.');
(async()=>{
 const pdf=require('pdf-lib'),draw=pdf.PDFPage.prototype.drawText;let lines=0;
 pdf.PDFPage.prototype.drawText=function(value,options){
  if(options.y!==26){assert(options.y>=48,'Text must not run below the page');assert(options.x+options.font.widthOfTextAtSize(value,options.size)<=542,'Text must fit its page width');}
  lines++;return draw.call(this,value,options);
 };
 try{
 const generate=load('src/lib/contracts/generate-contract-pdf.ts',{'pdf-lib':pdf}).generateContractPdf;
 const result=await generate({generated_at:'2026-11-17T10:00:00Z',contract:{id:'c',number:'FIELDS-1',title:'Kundfält',value:0,currency:'SEK',binding_months:0,notice_months:0},version:{id:'v',number:1,body:Array.from({length:160},(_,i)=>`Avtalsrad ${i}`).join('\n'),terms:'Villkor',commercial_terms:{custom_fields:{definitions:[{id:'meter',label:'Anläggningsidentifikation'.repeat(5)}],values:{meter:'0'.repeat(1000)}}}},seller:{legal_name:'Fixture'},counterparty:{display_name:'Fixture'},source_call:{id:'call',ended_at:'2026-11-17'}},'fixture');
 assert((await pdf.PDFDocument.load(result)).getPageCount()>3);assert(lines>200);
 }finally{pdf.PDFPage.prototype.drawText=draw;}
 console.log('PASS: real canonical PDF paginates long field labels/IDs and multiline terms; all drawn text stays inside page bounds.');
})().catch(e=>{console.error(e);process.exitCode=1;});
let editorPdf;
const editor=load('src/components/contract-template-fields.tsx',{'@/lib/contracts/pdf-field-template':fields,'@/components/pdf-template-builder':{PdfTemplateBuilder:props=>{editorPdf=props;return React.createElement('div');}}}).ContractTemplateFields;
const legacyEditorHtml=renderToStaticMarkup(React.createElement(editor,{initial:[],pdf:{...pdf,customFields:[defs[0]]}}));
assert(legacyEditorHtml.includes('name="custom_fields"'));assert(legacyEditorHtml.includes('anlaggning_id'));
assert.equal(editorPdf.customFields[0].id,'anlaggning_id');assert.equal(editorPdf.initial.customFields.length,0);assert.equal(editorPdf.managedCustomFields,true,'Use one field-definition editor for text and PDF, including legacy definitions');
console.log('PASS: legacy PDF definitions are promoted into the unified editor without duplicate field declarations.');
